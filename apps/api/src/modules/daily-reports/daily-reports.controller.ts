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
} from '@nestjs/common';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { JsonInput, QueryInput } from '../../input-boundary';
import { DailyReportsService } from './daily-reports.service';
import {
  DailyHistoryDto,
  GenerateReportDto,
  RegenerateReportDto,
  ReportRequestDto,
  ReportSettingsDto,
  SendReportDto,
  TestEmailDto,
} from './daily-reports.dto';
@Controller('daily-reports')
export class DailyReportsController {
  constructor(private readonly reports: DailyReportsService) {}
  @Get() @QueryInput() @RequirePermissions('daily_reports.read') list(
    @Query() q: DailyHistoryDto,
  ) {
    return this.reports.list(Number(q.page ?? 1));
  }
  @Get('settings') @RequirePermissions('daily_reports.manage') settings() {
    return this.reports.settings();
  }
  @Patch('settings')
  @JsonInput()
  @RequirePermissions('daily_reports.manage')
  update(@Body() q: ReportSettingsDto, @Req() a: AuthRequest) {
    return this.reports.updateSettings(q, a);
  }
  @Get('deliveries') @RequirePermissions('daily_reports.read') deliveries() {
    return this.reports.deliveries();
  }
  @Post('test-email')
  @JsonInput()
  @RequirePermissions('daily_reports.send')
  test(@Body() q: TestEmailDto, @Req() a: AuthRequest) {
    return this.reports.send(null, q, a);
  }
  @Post() @JsonInput() @RequirePermissions('daily_reports.manage') generate(
    @Body() q: GenerateReportDto,
    @Req() a: AuthRequest,
  ) {
    return this.reports.generate(q, a);
  }
  @Get(':id') @RequirePermissions('daily_reports.read') detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.reports.detail(id);
  }
  @Post(':id/regenerate')
  @JsonInput()
  @RequirePermissions('daily_reports.manage')
  regenerate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() q: RegenerateReportDto,
    @Req() a: AuthRequest,
  ) {
    return this.reports.regenerate(id, q, a);
  }
  @Post(':id/send') @JsonInput() @RequirePermissions('daily_reports.send') send(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() q: SendReportDto,
    @Req() a: AuthRequest,
  ) {
    return this.reports.send(id, q, a);
  }
  @Post('deliveries/:id/retry')
  @JsonInput()
  @RequirePermissions('daily_reports.send')
  retry(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() q: ReportRequestDto,
    @Req() a: AuthRequest,
  ) {
    return this.reports.retry(id, q.requestId, a);
  }
}
