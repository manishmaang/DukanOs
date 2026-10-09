import { Type } from 'class-transformer';
import {
  IsDefined,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { PlatformSource, ServingMode } from '@dukanos/shared-types';
export class ServingDto {
  @IsIn(['NORMAL', 'REDUCED']) mode!: ServingMode;
  @IsString() @Matches(/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/) amount!: string;
  @IsIn(['g', 'ml']) unit!: 'g' | 'ml';
}
export class PlatformLineDto {
  @IsUUID('4') variantId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  instruction?: string;
  @IsDefined() @ValidateNested() @Type(() => ServingDto) serving!: ServingDto;
}
export class PlatformOrderDto {
  @IsUUID('4') requestId!: string;
  @IsIn(['ZOMATO', 'SWIGGY']) source!: PlatformSource;
  @IsString()
  @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9_-]{0,79}\s*$/)
  @MaxLength(100)
  externalReference!: string;
  @IsIn(['NONE', 'APPLIED', 'UNKNOWN']) discountClassification!:
    'NONE' | 'APPLIED' | 'UNKNOWN';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlatformLineDto)
  lines!: PlatformLineDto[];
}
export class PlatformListDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(80)
  search?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') after?: string;
}
export class PlatformMenuDto {
  @IsIn(['ZOMATO', 'SWIGGY']) source!: PlatformSource;
}
export class PlatformCancelDto {
  @IsString() @Matches(/\S/) @MaxLength(500) reason!: string;
}
