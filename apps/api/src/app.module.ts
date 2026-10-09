import { DailyReportsModule } from './modules/daily-reports/daily-reports.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { OrdersModule } from './modules/orders/orders.module';
import { MenuModule } from './modules/menu/menu.module';
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { ReleaseReadiness } from './health/release-readiness';
@Module({
  imports: [
    DatabaseModule,
    DailyReportsModule,
    AuthModule,
    MenuModule,
    OrdersModule,
    KitchenModule,
    DispatchModule,
    AlertsModule,
    ReportsModule,
    ExpensesModule,
  ],
  controllers: [HealthController],
  providers: [ReleaseReadiness],
})
export class AppModule {}
