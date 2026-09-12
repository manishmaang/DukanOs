import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { MenuService } from './menu.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateItemDto,
  UpdateItemDto,
  CreateVariantDto,
  UpdateVariantDto,
  PriceDto,
  ChannelAvailabilityDto,
} from './menu.dto';
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}
  @Get() @RequirePermissions('menu.read') operational(
    @Query('channel') channel: string,
  ) {
    return this.menu.operational(channel);
  }
  @Get('channels') @RequirePermissions('menu.read') async channels() {
    return (await this.menu.catalog()).channels;
  }
  @Get('admin') @RequirePermissions('menu.manage') admin() {
    return this.menu.catalog();
  }
  @Get('categories') @RequirePermissions('menu.manage') async categories() {
    return (await this.menu.catalog()).categories;
  }
  @Post('categories') @RequirePermissions('menu.manage') createCategory(
    @Body() input: CreateCategoryDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.createCategory(input, actor);
  }
  @Patch('categories/:id') @RequirePermissions('menu.manage') updateCategory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateCategoryDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.updateCategory(id, input, actor);
  }
  @Get('items') @RequirePermissions('menu.manage') async items() {
    return (await this.menu.catalog()).items;
  }
  @Get('items/:id') @RequirePermissions('menu.manage') item(
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.menu.item(id);
  }
  @Post('items') @RequirePermissions('menu.manage') createItem(
    @Body() input: CreateItemDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.createItem(input, actor);
  }
  @Patch('items/:id') @RequirePermissions('menu.manage') updateItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateItemDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.updateItem(id, input, actor);
  }
  @Post('items/:id/variants') @RequirePermissions('menu.manage') createVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateVariantDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.createVariant(id, input, actor);
  }
  @Patch('variants/:id') @RequirePermissions('menu.manage') updateVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateVariantDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.updateVariant(id, input, actor);
  }
  @Put('variants/:id/channels/:code/price')
  @RequirePermissions('menu.manage')
  price(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code') code: string,
    @Body() input: PriceDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.setPrice(id, code, input, actor);
  }
  @Patch('variants/:id/channels/:code/availability')
  @RequirePermissions('menu.manage')
  availability(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code') code: string,
    @Body() input: ChannelAvailabilityDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.setAvailability(id, code, input, actor);
  }
}
