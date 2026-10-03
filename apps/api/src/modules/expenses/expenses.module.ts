import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ExpenseMediaService } from './expense-media.service';
@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService, ExpenseMediaService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
