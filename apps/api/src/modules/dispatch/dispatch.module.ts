import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';
@Module({
  imports: [OrdersModule],
  controllers: [DispatchController],
  providers: [DispatchService],
})
export class DispatchModule {}
