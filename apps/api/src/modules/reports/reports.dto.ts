import { ReportPeriodDto } from '../../reporting/period.dto';
export { ReportPeriodDto } from '../../reporting/period.dto';
import { IsIn, IsString, Matches, ValidateIf } from 'class-validator';
export class ReportItemsDto extends ReportPeriodDto {
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['QUANTITY', 'SALES']) sort?:
    'QUANTITY' | 'SALES';
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,4}$/)
  page?: string;
}
