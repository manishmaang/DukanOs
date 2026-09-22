import {
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
import { DispatchService } from './dispatch.service';
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}
  @Get('orders') @RequirePermissions('dispatch.read') orders() {
    return this.dispatch.state();
  }
  @Post('orders/:id/complete')
  @HttpCode(200)
  @RequirePermissions('dispatch.complete')
  complete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.lifecycle.transition(id, 'COMPLETED', actor);
  }
}
