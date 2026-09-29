import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import type { AmendmentReason } from '@dukanos/shared-types';
class RevisionLineDto {
  @IsUUID('4') id!: string;
  @IsUUID('4') variantId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
  @IsString() @MaxLength(500) instruction!: string;
}
export class AmendmentDto {
  @IsUUID('4') requestId!: string;
  @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
  @IsIn(['CHANGE', 'CANCEL']) kind!: 'CHANGE' | 'CANCEL';
  @IsIn([
    'CUSTOMER_CHANGE',
    'WRONG_ITEM_SELECTED',
    'WRONG_PORTION',
    'ITEM_UNAVAILABLE',
    'CASHIER_CORRECTION',
    'OTHER',
  ])
  reason!: AmendmentReason;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  note?: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RevisionLineDto)
  lines!: RevisionLineDto[];
}
export class CommitAmendmentDto extends AmendmentDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) quoteHash!: string;
}
