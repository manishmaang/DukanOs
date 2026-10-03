import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { JsonInput, MultipartInput, QueryInput } from '../../input-boundary';
import { ExpensesService } from './expenses.service';
import {
  CreateExpenseDto,
  ExpenseCategoryDto,
  ExpensesQueryDto,
  UpdateExpenseCategoryDto,
  VoidExpenseDto,
} from './expenses.dto';
import { MAX_IMAGE_UPLOAD, type PhotoUpload } from './expense-media.service';
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}
  @Get('expense-categories') @RequirePermissions('expenses.read') categories() {
    return this.expenses.configuration();
  }
  @Post('expense-categories')
  @JsonInput()
  @RequirePermissions('expense_categories.manage')
  category(@Body() q: ExpenseCategoryDto, @Req() actor: AuthRequest) {
    return this.expenses.category(q, actor);
  }
  @Patch('expense-categories/:id')
  @JsonInput()
  @RequirePermissions('expense_categories.manage')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() q: UpdateExpenseCategoryDto,
    @Req() actor: AuthRequest,
  ) {
    return this.expenses.category(q, actor, id);
  }
  @Get('expenses') @QueryInput() @RequirePermissions('expenses.read') list(
    @Query() q: ExpensesQueryDto,
  ) {
    return this.expenses.list(q);
  }
  @Get('expenses/:id') @RequirePermissions('expenses.read') get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.expenses.get(id);
  }
  @Post('expenses') @JsonInput() @RequirePermissions('expenses.create') create(
    @Body() q: CreateExpenseDto,
    @Req() actor: AuthRequest,
  ) {
    return this.expenses.create(q, actor);
  }
  @Post('expenses/:id/void')
  @JsonInput()
  @RequirePermissions('expenses.manage')
  void(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() q: VoidExpenseDto,
    @Req() actor: AuthRequest,
  ) {
    return this.expenses.void(id, q, actor);
  }
  @Post('expenses/receipts')
  @MultipartInput()
  @RequirePermissions('expenses.create')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_UPLOAD, files: 1, fields: 0, parts: 2 },
    }),
  )
  upload(
    @UploadedFile() file: PhotoUpload | undefined,
    @Req() actor: AuthRequest,
  ) {
    return this.expenses.upload(file, actor);
  }
  @Get('expenses/receipts/:key')
  @RequirePermissions('expenses.read')
  async receipt(
    @Param('key', new ParseUUIDPipe({ version: '4' })) key: string,
    @Req() actor: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const bytes = await this.expenses.readReceipt(key, actor);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return new StreamableFile(bytes, {
      type: 'image/webp',
      disposition: 'inline',
      length: bytes.length,
    });
  }
}
