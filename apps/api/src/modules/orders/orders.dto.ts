import { Type } from 'class-transformer';
import {
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
export class OrderLineDto {
  @IsUUID('4') variantId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  instruction?: string;
}
export class ConfirmationPaymentDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/)
  expectedDue!: string;
  @IsString() @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/) cash!: string;
  @IsString() @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/) upi!: string;
}
export class ConfirmOrderDto {
  @ValidateIf((_o, v) => v !== undefined)
  @ValidateNested()
  @Type(() => ConfirmationPaymentDto)
  payment?: ConfirmationPaymentDto;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') billId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['DINE_IN', 'TAKEAWAY'])
  serviceType?: 'DINE_IN' | 'TAKEAWAY';
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(80)
  reference?: string;
  @IsUUID('4') requestId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}
export class OrdersQueryDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['QUEUED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'])
  status?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  businessDate?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') after?: string;
}
