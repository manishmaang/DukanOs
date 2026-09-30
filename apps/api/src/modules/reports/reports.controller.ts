import { Controller, Get, Query } from '@nestjs/common';
import { QueryInput } from '../../input-boundary';
import { RequirePermissions } from '../auth/access';
import { ReportItemsDto, ReportPeriodDto } from './reports.dto';
import { ReportsService } from './reports.service';
@Controller()
@RequirePermissions('reports.read')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get('dashboard') @QueryInput() dashboard(@Query() q: ReportPeriodDto) {
    return this.reports.dashboard(q);
  }
  @Get('reports/sales') @QueryInput() sales(@Query() q: ReportPeriodDto) {
    return this.reports.sales(q);
  }
  @Get('reports/payments') @QueryInput() payments(@Query() q: ReportPeriodDto) {
    return this.reports.payments(q);
  }
  @Get('reports/items') @QueryInput() items(@Query() q: ReportItemsDto) {
    return this.reports.items(q);
  }
  @Get('reports/operations') @QueryInput() operations(
    @Query() q: ReportPeriodDto,
  ) {
    return this.reports.operations(q);
  }
}
