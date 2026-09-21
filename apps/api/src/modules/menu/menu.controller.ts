import { JsonInput, MultipartInput, QueryInput } from '../../input-boundary';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  MAX_IMAGE_UPLOAD,
  IMAGE_MIMES,
  type PhotoUpload,
} from './menu-media.service';
import {
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  StreamableFile,
  Res,
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
  SaveItemDto,
  MenuQueryDto,
  CounterAvailabilityDto,
  ChannelCodePipe,
} from './menu.dto';
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}
  @MultipartInput()
  @Post('images')
  @RequirePermissions('menu.manage')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_UPLOAD, files: 1, fields: 0, parts: 2 },
      fileFilter: (_req, file, done) => {
        if (!IMAGE_MIMES.includes(file.mimetype))
          return done(
            new BadRequestException({
              code: 'INVALID_MENU_IMAGE',
              message: 'Choose a JPEG, PNG or WebP photo.',
            }),
            false,
          );
        done(null, true);
      },
    }),
  )
  uploadImage(
    @UploadedFile() file: PhotoUpload | undefined,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.uploadImage(file, actor);
  }
  @Get('images/:key')
  @RequirePermissions('menu.read')
  async image(
    @Param('key', new ParseUUIDPipe({ version: '4' })) key: string,
    @Req() actor: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const image = await this.menu.readImage(key, actor);
    response.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    return new StreamableFile(image, {
      type: 'image/webp',
      disposition: 'inline',
      length: image.length,
    });
  }
  @QueryInput()
  @Get()
  @RequirePermissions('menu.read')
  operational(@Query() query: MenuQueryDto) {
    return this.menu.operational(query.channel);
  }
  @Get('counter') @RequirePermissions('menu.read') counter() {
    return this.menu.counter();
  }
  @Patch('counter/items/:id/availability')
  @RequirePermissions('menu.availability.manage')
  @JsonInput()
  counterAvailability(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: CounterAvailabilityDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.setCounterAvailability(id, input, actor);
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
  @Post('categories')
  @RequirePermissions('menu.manage')
  @JsonInput()
  createCategory(@Body() input: CreateCategoryDto, @Req() actor: AuthRequest) {
    return this.menu.createCategory(input, actor);
  }
  @Patch('categories/:id')
  @RequirePermissions('menu.manage')
  @JsonInput()
  updateCategory(
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
  @Post('items') @RequirePermissions('menu.manage') @JsonInput() createItem(
    @Body() input: CreateItemDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.createItem(input, actor);
  }
  @Put('items/:id') @RequirePermissions('menu.manage') @JsonInput() saveItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SaveItemDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.replaceItem(id, input, actor);
  }
  @Patch('items/:id')
  @RequirePermissions('menu.manage')
  @JsonInput()
  updateItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateItemDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.updateItem(id, input, actor);
  }
  @Post('items/:id/variants')
  @RequirePermissions('menu.manage')
  @JsonInput()
  createVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateVariantDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.createVariant(id, input, actor);
  }
  @Patch('variants/:id')
  @RequirePermissions('menu.manage')
  @JsonInput()
  updateVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateVariantDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.updateVariant(id, input, actor);
  }
  @Put('variants/:id/channels/:code/price')
  @RequirePermissions('menu.manage')
  @JsonInput()
  price(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code', new ChannelCodePipe()) code: string,
    @Body() input: PriceDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.setPrice(id, code, input, actor);
  }
  @Patch('variants/:id/channels/:code/availability')
  @RequirePermissions('menu.manage')
  @JsonInput()
  availability(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('code', new ChannelCodePipe()) code: string,
    @Body() input: ChannelAvailabilityDto,
    @Req() actor: AuthRequest,
  ) {
    return this.menu.setAvailability(id, code, input, actor);
  }
}
