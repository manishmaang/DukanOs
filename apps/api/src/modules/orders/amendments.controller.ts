import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { JsonInput } from '../../input-boundary';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { AmendmentDto, CommitAmendmentDto } from './amendments.dto';
import { AmendmentsService } from './amendments.service';
@Controller('orders/:id/amendments')
export class AmendmentsController {
  constructor(private readonly amendments: AmendmentsService) {}
  @Post('quote')
  @JsonInput()
  @RequirePermissions('orders.amend', 'bills.read', 'payments.read')
  quote(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: AmendmentDto,
    @Req() actor: AuthRequest,
  ) {
    return this.amendments.quote(id, input, actor);
  }
  @Post()
  @JsonInput()
  @RequirePermissions('orders.amend', 'bills.read', 'payments.read')
  commit(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: CommitAmendmentDto,
    @Req() actor: AuthRequest,
  ) {
    return this.amendments.commit(id, input, actor);
  }
  @Get()
  @RequirePermissions('orders.read', 'bills.read', 'payments.read')
  history(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.amendments.history(id);
  }
}
