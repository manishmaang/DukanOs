import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
export class ReportRequestDto {
  @IsUUID('4') requestId!: string;
}
export class GenerateReportDto extends ReportRequestDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate!: string;
}
export class RegenerateReportDto extends ReportRequestDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
export class SendReportDto extends ReportRequestDto {
  @IsBoolean() confirmResend!: boolean;
}
export class ReportSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEmail({}, { each: true })
  @MaxLength(254, { each: true })
  recipients!: string[];
  @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class TestEmailDto extends ReportRequestDto {
  @IsEmail() @MaxLength(254) recipient!: string;
}
export class DailyHistoryDto {
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^[1-9]\d{0,4}$/)
  page?: string;
}
