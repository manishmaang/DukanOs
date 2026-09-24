import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { JsonInput, QueryInput } from '../../input-boundary';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { BillsService } from './bills.service';
import { BillsQueryDto, CollectPaymentDto } from './bills.dto';
@Controller('bills')
export class BillsController {
  constructor(private readonly bills: BillsService) {}
  @Get() @QueryInput() @RequirePermissions('bills.read', 'payments.read') list(
    @Query() q: BillsQueryDto,
  ) {
    return this.bills.list(q);
  }
  @Get(':id') @RequirePermissions('bills.read', 'payments.read') get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.bills.get(id);
  }
  @Post(':id/payments')
  @JsonInput()
  @RequirePermissions('payments.collect', 'bills.read')
  collect(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: CollectPaymentDto,
    @Req() actor: AuthRequest,
  ) {
    return this.bills.collect(id, input, actor);
  }
  @Post(':id/close') @RequirePermissions('bills.manage') close(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.bills.close(id, actor);
  }
}
