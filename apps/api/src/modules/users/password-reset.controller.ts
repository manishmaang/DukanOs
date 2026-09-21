import { JsonInput } from '../../input-boundary';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { IsInt, IsString, Length, Min, Max } from 'class-validator';
import { RequirePermissions, type AuthRequest } from '../auth/access';
import { PasswordManagementService } from './password-management.service';
class ResetPasswordDto {
  @IsString() @Length(12, 128) newPassword!: string;
  @IsString() @Length(1, 500) reason!: string;
  @IsInt() @Min(1) @Max(2147483647) version!: number;
}
@Controller('users')
@RequirePermissions('users.password.reset')
export class PasswordResetController {
  constructor(private readonly passwords: PasswordManagementService) {}
  @Get('password-reset-targets') list(@Req() request: AuthRequest) {
    return this.passwords.resetTargets(request.user);
  }
  @Post(':id/password-reset')
  @HttpCode(204)
  @JsonInput()
  reset(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ResetPasswordDto,
    @Req() request: AuthRequest,
  ) {
    return this.passwords.resetStaff(
      request.user.id,
      request.sessionHash,
      id,
      input,
    );
  }
}
