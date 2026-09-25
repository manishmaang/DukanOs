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
import { AlertsService } from './alerts.service';
import { ReminderDto, SnoozeDto, TimerDto } from './alerts.dto';
@Controller()
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}
  @Get('reminders/active')
  @RequirePermissions('bills.reminders.read')
  reminders() {
    return this.alerts.reminders();
  }
  @Post('bills/:id/reminder')
  @JsonInput()
  @RequirePermissions('bills.reminders.manage')
  configure(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ReminderDto,
    @Req() actor: AuthRequest,
  ) {
    return this.alerts.configure(id, input.intervalMinutes, actor);
  }
  @Post('bills/:id/reminder/snooze')
  @JsonInput()
  @RequirePermissions('bills.reminders.manage')
  snooze(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: SnoozeDto,
    @Req() actor: AuthRequest,
  ) {
    return this.alerts.snooze(id, input.version, actor);
  }
  @Get('kitchen/timers') @RequirePermissions('kitchen.timers.read') timers() {
    return this.alerts.timers();
  }
  @Post('kitchen/timers')
  @JsonInput()
  @RequirePermissions('kitchen.timers.manage')
  create(@Body() input: TimerDto, @Req() actor: AuthRequest) {
    return this.alerts.create(input, actor);
  }
  @Post('kitchen/timers/:id/acknowledge')
  @RequirePermissions('kitchen.timers.manage')
  acknowledge(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.alerts.resolve(id, 'ACKNOWLEDGED', actor);
  }
  @Post('kitchen/timers/:id/cancel')
  @RequirePermissions('kitchen.timers.manage')
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() actor: AuthRequest,
  ) {
    return this.alerts.resolve(id, 'CANCELLED', actor);
  }
}
