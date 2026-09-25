import { Module } from '@nestjs/common';
import { BillsModule } from '../bills/bills.module';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';
@Module({
  imports: [BillsModule],
  providers: [AlertsService],
  controllers: [AlertsController],
})
export class AlertsModule {}
