import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
@Module({
  imports: [MenuModule],
  providers: [OrdersService],
  controllers: [OrdersController],
})
export class OrdersModule {}
