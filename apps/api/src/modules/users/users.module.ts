import { PasswordManagementService } from './password-management.service';
import { PasswordResetController } from './password-reset.controller';
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
@Module({
  providers: [UsersService, PasswordManagementService],
  controllers: [UsersController, PasswordResetController],
  exports: [UsersService, PasswordManagementService],
})
export class UsersModule {}
