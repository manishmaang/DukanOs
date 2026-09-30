import { RestaurantClock } from './restaurant-clock';
import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
@Global()
@Module({
  providers: [DatabaseService, RestaurantClock],
  exports: [DatabaseService, RestaurantClock],
})
export class DatabaseModule {}
