import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { ExpenseMethod, ExpenseVoidReason } from '@dukanos/shared-types';
import { ReportPeriodDto } from '../../reporting/period.dto';
export class CreateExpenseDto {
  @IsUUID('4') requestId!: string;
  @IsString() @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/) amount!: string;
  @IsUUID('4') categoryId!: string;
  @IsIn(['CASH', 'UPI']) paymentMethod!: ExpenseMethod;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  businessDate?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(120)
  vendor?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  note?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') receiptKey?: string;
}
export class VoidExpenseDto {
  @IsUUID('4') requestId!: string;
  @IsIn([
    'DUPLICATE_ENTRY',
    'WRONG_AMOUNT',
    'WRONG_CATEGORY',
    'NOT_A_BUSINESS_EXPENSE',
    'OTHER',
  ])
  reason!: ExpenseVoidReason;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(500)
  note?: string;
}
export class ExpenseCategoryDto {
  @IsString() @Length(1, 100) name!: string;
}
export class UpdateExpenseCategoryDto extends ExpenseCategoryDto {
  @IsBoolean() active!: boolean;
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}
export class ExpensesQueryDto extends ReportPeriodDto {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID('4') categoryId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['CASH', 'UPI'])
  paymentMethod?: ExpenseMethod;
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['ACTIVE', 'VOIDED']) status?:
    'ACTIVE' | 'VOIDED';
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MaxLength(120)
  search?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/^[1-9]\d{0,4}$/)
  page?: string;
}
