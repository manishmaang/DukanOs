import { BillRolloverService } from './bill-rollover.service';
import { Module } from '@nestjs/common';
import { BillsService } from './bills.service';
import { BillsController } from './bills.controller';
@Module({
  providers: [BillsService, BillRolloverService],
  controllers: [BillsController],
  exports: [BillsService, BillRolloverService],
})
export class BillsModule {}
