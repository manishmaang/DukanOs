import {
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
export class FulfillmentDto {
  @IsUUID('4') requestId!: string;
  @IsInt() @Min(0) @Max(2147483646) expectedRevision!: number;
}
export class ServeLineDto extends FulfillmentDto {
  @IsInt() @Min(0) @Max(99) expectedServedQuantity!: number;
  @IsInt() @Min(-99) @Max(99) @NotEquals(0) quantity!: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  reason?: string;
}
