import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  Max,
  Matches,
  ValidateNested,
} from 'class-validator';
export class CategoryFields {
  @ValidateIf(
    (o, value) => o instanceof CreateCategoryDto || value !== undefined,
  )
  @IsString()
  @Length(1, 100)
  name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() active?: boolean;
}
export class CreateCategoryDto extends CategoryFields {
  @IsString() @Length(1, 100) declare name: string;
}
export class UpdateCategoryDto extends CategoryFields {
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}
export class VariantFields {
  @ValidateIf(
    (o, value) => o instanceof InitialVariantDto || value !== undefined,
  )
  @IsString()
  @Length(1, 80)
  name?: string;
  @IsOptional() @IsString() @MaxLength(40) displayLabel?: string | null;
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() active?: boolean;
}
export class InitialVariantDto extends VariantFields {
  @IsString() @Length(1, 80) declare name: string;
}
export class CreateVariantDto extends InitialVariantDto {
  @IsInt() @Min(1) @Max(2147483647) itemVersion!: number;
}
export class UpdateVariantDto extends VariantFields {
  @IsInt() @Min(1) @Max(2147483647) itemVersion!: number;
}
export class ItemFields {
  @ValidateIf((o, value) => o instanceof CreateItemDto || value !== undefined)
  @IsUUID()
  categoryId?: string;
  @ValidateIf((o, value) => o instanceof CreateItemDto || value !== undefined)
  @IsString()
  @Length(1, 120)
  name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(120) kitchenName?: string | null;
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() active?: boolean;
}
export class ItemChannelDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,31}$/) channelCode!: string;
  @IsString() @MaxLength(32) price!: string;
  @IsBoolean() available!: boolean;
}
export class ItemVariantDto extends InitialVariantDto {
  @ValidateIf((_o, value) => value !== undefined) @IsUUID() id?: string;
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemChannelDto)
  channels?: ItemChannelDto[];
}
export class CreateItemDto extends ItemFields {
  @IsOptional() @IsUUID('4') imageKey?: string | null;
  @IsUUID() declare categoryId: string;
  @IsString() @Length(1, 120) declare name: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemVariantDto)
  variants!: ItemVariantDto[];
}
export class UpdateItemDto extends ItemFields {
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}
export class PriceDto {
  @IsString() @MaxLength(32) price!: string;
  @IsInt() @Min(1) @Max(2147483647) itemVersion!: number;
}
export class ChannelAvailabilityDto {
  @IsBoolean() available!: boolean;
  @IsInt() @Min(1) @Max(2147483647) itemVersion!: number;
}

export class SaveItemDto extends CreateItemDto {
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}

export class MenuQueryDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,31}$/) channel!: string;
}
export class ChannelCodePipe implements PipeTransform {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,31}$/.test(value))
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'Use a valid sales-channel code.',
      });
    return value;
  }
}
export class CounterAvailabilityDto {
  @IsInt() @Min(1) @Max(2147483647) version!: number;
  @IsBoolean() available!: boolean;
  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID('4')
  variantId?: string;
}
