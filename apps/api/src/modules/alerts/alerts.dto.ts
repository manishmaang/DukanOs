import {
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
export class ReminderDto {
  @IsInt() @Min(1) @Max(1440) intervalMinutes!: number;
}
export class SnoozeDto {
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}
export class TimerDto {
  @IsUUID('4') requestId!: string;
  @IsString() @MaxLength(120) @Matches(/\S/) label!: string;
  @IsInt() @Min(60) @Max(86400) durationSeconds!: number;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') orderId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') orderItemId?: string;
}
