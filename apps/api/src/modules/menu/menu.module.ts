import { MenuMediaService } from './menu-media.service';
import { Module } from '@nestjs/common';
import { MenuService } from './menu.service';
import { MenuController } from './menu.controller';
@Module({
  providers: [MenuService, MenuMediaService],
  controllers: [MenuController],
  exports: [MenuService],
})
export class MenuModule {}
