import { FulfillmentService } from './fulfillment.service';
import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
@Module({
  imports: [OrdersModule],
  controllers: [KitchenController],
  providers: [KitchenService, FulfillmentService],
})
export class KitchenModule {}
