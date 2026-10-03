import { IsIn, IsString, Matches, ValidateIf } from 'class-validator';
import type { ReportPreset } from '@dukanos/shared-types';
export class ReportPeriodDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'THIS_MONTH', 'CUSTOM'])
  period?: ReportPreset;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}
