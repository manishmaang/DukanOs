import { JsonInput } from '../../input-boundary';
import { FulfillmentDto, ServeLineDto } from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { KitchenService } from './kitchen.service';
@Controller('kitchen')
export class KitchenController {
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly kitchen: KitchenService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}
  @Post('orders/:id/lines/:line/serve')
  @HttpCode(200)
  @JsonInput()
  @RequirePermissions('kitchen.fulfill')
  serve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('line', new ParseUUIDPipe({ version: '4' })) line: string,
    @Body() body: ServeLineDto,
    @Req() actor: AuthRequest,
  ) {
    return this.fulfillment.serve(id, line, body, actor);
  }
  @Post('orders/:id/fulfill')
  @HttpCode(200)
  @JsonInput()
  @RequirePermissions('kitchen.fulfill')
  fulfill(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: FulfillmentDto,
    @Req() actor: AuthRequest,
  ) {
    return this.fulfillment.fulfill(id, body, actor);
  }
  @Get('orders') @RequirePermissions('kitchen.read') orders() {
    return this.kitchen.state();
  }
  @Get('production') @RequirePermissions('kitchen.read') async production() {
    const { serverTime, production } = await this.kitchen.state();
    return { serverTime, ...production };
  }
  @Post('orders/:id/start')
  @HttpCode(200)
  @RequirePermissions('kitchen.update')
  start(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.lifecycle.transition(id, 'PREPARING', actor);
  }
  @Post('orders/:id/ready')
  @HttpCode(200)
  @RequirePermissions('kitchen.update')
  ready(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.lifecycle.transition(id, 'READY', actor);
  }
}
