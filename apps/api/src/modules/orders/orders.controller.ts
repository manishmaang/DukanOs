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
import { ConfirmOrderDto, OrdersQueryDto } from './orders.dto';
import { OrdersService } from './orders.service';
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Post('counter/quote')
  @JsonInput()
  @RequirePermissions('orders.create', 'bills.read', 'payments.read')
  quote(@Body() input: ConfirmOrderDto, @Req() actor: AuthRequest) {
    return this.orders.quote(input, actor);
  }
  @Post('counter')
  @JsonInput()
  @RequirePermissions('orders.create')
  confirm(@Body() input: ConfirmOrderDto, @Req() actor: AuthRequest) {
    return this.orders.confirm(input, actor);
  }
  @Get('configuration') @RequirePermissions('orders.create') configuration() {
    return this.orders.config();
  }
  @Get('tokens/:date/:token')
  @RequirePermissions('orders.read')
  token(@Param('date') date: string, @Param('token') token: string) {
    return this.orders.token(date, token);
  }
  @Get() @QueryInput() @RequirePermissions('orders.read') list(
    @Query() query: OrdersQueryDto,
  ) {
    return this.orders.list(query);
  }
  @Get(':id') @RequirePermissions('orders.read') get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.orders.get(id);
  }
}
