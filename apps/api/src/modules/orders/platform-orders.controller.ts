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
import { PlatformOrdersService } from './platform-orders.service';
import {
  PlatformCancelDto,
  PlatformListDto,
  PlatformMenuDto,
  PlatformOrderDto,
} from './platform-orders.dto';
@Controller('platform-orders')
export class PlatformOrdersController {
  constructor(private readonly service: PlatformOrdersService) {}
  @Get('menu') @QueryInput() @RequirePermissions('platform_orders.create') menu(
    @Query() q: PlatformMenuDto,
  ) {
    return this.service.menu(q.source);
  }
  @Post() @JsonInput() @RequirePermissions('platform_orders.create') create(
    @Body() input: PlatformOrderDto,
    @Req() actor: AuthRequest,
  ) {
    return this.service.create(input, actor);
  }
  @Get() @QueryInput() @RequirePermissions('platform_orders.read') list(
    @Query() q: PlatformListDto,
  ) {
    return this.service.list(q);
  }
  @Get(':id') @RequirePermissions('platform_orders.read') get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.get(id);
  }
  @Post(':id/cancel')
  @JsonInput()
  @RequirePermissions('platform_orders.cancel')
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: PlatformCancelDto,
    @Req() actor: AuthRequest,
  ) {
    return this.service.cancel(id, input.reason, actor);
  }
}
