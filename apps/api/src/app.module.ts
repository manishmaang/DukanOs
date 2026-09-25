import { AlertsModule } from './modules/alerts/alerts.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { OrdersModule } from './modules/orders/orders.module';
import { MenuModule } from './modules/menu/menu.module';
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    MenuModule,
    OrdersModule,
    KitchenModule,
    DispatchModule,
    AlertsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
