import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  mkdir,
  writeFile,
  rename,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { DatabaseService } from '../../database/database.service';
import type { AuthRequest } from '../auth/access';
import type { MenuImage } from '@dukanos/shared-types';

export const MAX_IMAGE_UPLOAD = 5 * 1024 * 1024;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const imageUrl = (key: string) => `/api/menu/images/${key}`;
const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface PhotoUpload {
  buffer: Buffer;
  mimetype: string;
}
@Injectable()
export class MenuMediaService {
  readonly directory: string;
  private readonly logger = new Logger(MenuMediaService.name);
  constructor(private readonly db: DatabaseService) {
    const base =
      process.env.DUKANOS_DATA_DIR ||
      join(homedir(), '.local', 'share', 'dukanos');
    if (!isAbsolute(base))
      throw new Error(
        'DUKANOS_DATA_DIR must be an absolute persistent directory.',
      );
    this.directory = join(base, 'uploads', 'menu');
  }
  private path(key: string) {
    if (!KEY.test(key))
      throw new NotFoundException({
        code: 'MENU_IMAGE_NOT_FOUND',
        message: 'Menu photo was not found.',
      });
    return join(this.directory, key + '.webp');
  }
  async prepare(
    file: PhotoUpload | undefined,
  ): Promise<MenuImage & { byteSize: number }> {
    if (!file || !IMAGE_MIMES.includes(file.mimetype) || !file.buffer?.length)
      throw new BadRequestException({
        code: 'INVALID_MENU_IMAGE',
        message: 'Choose a JPEG, PNG or WebP photo.',
      });
    if (file.buffer.length > MAX_IMAGE_UPLOAD)
      throw new BadRequestException({
        code: 'MENU_IMAGE_TOO_LARGE',
        message: 'Choose a photo no larger than 5 MB.',
      });
    let output: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    let data: Buffer;
    let width: number;
    let height: number;
    try {
      const pipeline = sharp(file.buffer, {
        limitInputPixels: 24_000_000,
        failOn: 'warning',
      });
      output = await pipeline.metadata();
      const formats: Record<string, string> = {
        'image/jpeg': 'jpeg',
        'image/png': 'png',
        'image/webp': 'webp',
      };
      if (output.format !== formats[file.mimetype] || (output.pages ?? 1) > 1)
        throw new Error('Unsupported image content');
      const result = await pipeline
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      data = result.data;
      width = result.info.width;
      height = result.info.height;
      if (data.length > 2 * 1024 * 1024)
        throw new Error('Processed image too large');
    } catch {
      throw new BadRequestException({
        code: 'INVALID_MENU_IMAGE',
        message:
          'This photo could not be read. Use a still JPEG, PNG or WebP under 5 MB and 24 megapixels.',
      });
    }
    const key = randomUUID();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, key + '.tmp');
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path(key));
    } catch (error) {
      await unlink(temporary).catch(() =>
        this.logger.warn(
          'Temporary menu photo cleanup deferred; run media:cleanup.',
        ),
      );
      throw error;
    }
    return { key, url: imageUrl(key), width, height, byteSize: data.length };
  }
  async exists(key: string) {
    try {
      const entry = await stat(this.path(key));
      return entry.isFile();
    } catch {
      return false;
    }
  }
  async read(key: string, actor: AuthRequest) {
    this.path(key);
    const result = await this.db.query(
      'SELECT 1 FROM menu_images m WHERE m.key=$1 AND (EXISTS(SELECT 1 FROM menu_items i WHERE i.image_key=m.key) OR (m.uploaded_by=$2 AND $3))',
      [key, actor.user.id, actor.user.permissions.includes('menu.manage')],
    );
    if (!result.rowCount)
      throw new NotFoundException({
        code: 'MENU_IMAGE_NOT_FOUND',
        message: 'Menu photo was not found.',
      });
    try {
      return await readFile(this.path(key));
    } catch {
      throw new NotFoundException({
        code: 'MENU_IMAGE_NOT_FOUND',
        message: 'This photo is missing from local storage.',
      });
    }
  }
  /** The common menu lock and FK row lock prevent deletion while attaching. */
  async discardUnused(
    key: string,
    dryRun = false,
  ): Promise<'removed' | 'candidate' | 'referenced' | 'deferred'> {
    try {
      return await this.db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(742019323)');
        await client.query(
          'SELECT key FROM menu_images WHERE key=$1 FOR UPDATE',
          [key],
        );
        if (
          (
            await client.query('SELECT 1 FROM menu_items WHERE image_key=$1', [
              key,
            ])
          ).rowCount
        )
          return 'referenced';
        if (dryRun) return 'candidate';
        await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        await client.query('DELETE FROM menu_images WHERE key=$1', [key]);
        return 'removed';
      });
    } catch {
      this.logger.warn(
        'Unused menu photo cleanup deferred; run media:cleanup to retry.',
      );
      return 'deferred';
    }
  }
  async cleanup(dryRun = false) {
    const report = { dryRun, candidates: 0, removed: 0, deferred: 0 };
    // Stages remain available for retry for 24 hours. Nothing runs at startup.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await this.db.query<{ key: string }>(
      "SELECT key FROM menu_images m WHERE created_at < now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM menu_items i WHERE i.image_key=m.key)",
    );
    for (const row of rows.rows) {
      const result = await this.discardUnused(row.key, dryRun);
      if (result !== 'referenced') report.candidates++;
      if (result === 'removed') report.removed++;
      if (result === 'deferred') report.deferred++;
    }
    const files = await readdir(this.directory).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      },
    );
    for (const file of files) {
      const key = file.replace(/\.(webp|tmp)$/, '');
      if (!KEY.test(key) || !/\.(webp|tmp)$/.test(file)) continue;
      // Avoid counting the same metadata-backed candidate again in a dry run.
      if (rows.rows.some((row) => row.key === key) && file.endsWith('.webp'))
        continue;
      const path = join(this.directory, file);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.mtimeMs >= cutoff) continue;
      try {
        await this.db.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(742019323)');
          if (
            (
              await client.query('SELECT 1 FROM menu_images WHERE key=$1', [
                key,
              ])
            ).rowCount
          )
            return;
          report.candidates++;
          if (!dryRun) {
            await unlink(path).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') throw e;
            });
            report.removed++;
          }
        });
      } catch {
        report.deferred++;
      }
    }
    return report;
  }
}
