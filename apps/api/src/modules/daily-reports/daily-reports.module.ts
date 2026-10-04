import { Module } from '@nestjs/common';
import { BillsModule } from '../bills/bills.module';
import { ReportsModule } from '../reports/reports.module';
import { DailyReportsController } from './daily-reports.controller';
import { DailyReportsService } from './daily-reports.service';
import { DailyWorkerService } from './daily-worker.service';
import { EmailDeliveryAdapter } from './email-adapter';
@Module({
  imports: [ReportsModule, BillsModule],
  controllers: [DailyReportsController],
  providers: [DailyReportsService, DailyWorkerService, EmailDeliveryAdapter],
  exports: [DailyWorkerService],
})
export class DailyReportsModule {}
