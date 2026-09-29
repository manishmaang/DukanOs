import { AmendmentsService } from './amendments.service';
import { AmendmentsController } from './amendments.controller';
import { BillsModule } from '../bills/bills.module';
import { OrderLifecycleService } from './order-lifecycle.service';
import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
@Module({
  imports: [MenuModule, BillsModule],
  providers: [OrdersService, OrderLifecycleService, AmendmentsService],
  exports: [OrderLifecycleService],
  controllers: [OrdersController, AmendmentsController],
})
export class OrdersModule {}
