import { Public } from '../modules/auth/access';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@dukanos/shared-types';
import { DatabaseService } from '../database/database.service';
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}
  @Get() live(): HealthResponse {
    return { status: 'ok', service: 'dukanos-api' };
  }
  @Get('ready') async ready(): Promise<HealthResponse> {
    try {
      await this.database.check();
    } catch {
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database is unavailable',
      });
    }
    return this.live();
  }
}
