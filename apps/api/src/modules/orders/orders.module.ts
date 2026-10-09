import { PlatformOrdersController } from './platform-orders.controller';
import { PlatformOrdersService } from './platform-orders.service';
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
  providers: [
    PlatformOrdersService,
    OrdersService,
    OrderLifecycleService,
    AmendmentsService,
  ],
  exports: [OrderLifecycleService],
  controllers: [
    PlatformOrdersController,
    OrdersController,
    AmendmentsController,
  ],
})
export class OrdersModule {}
