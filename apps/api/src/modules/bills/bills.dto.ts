import {
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
export class CollectPaymentDto {
  @IsUUID('4') requestId!: string;
  @IsIn(['CASH', 'UPI']) method!: 'CASH' | 'UPI';
  @IsString() @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/) amount!: string;
}
export class BillsQueryDto {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') after?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(80)
  search?: string;
}
