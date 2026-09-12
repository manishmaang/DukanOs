import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { UsersService } from './users.service';
import { RequirePermissions, type AuthRequest } from '../auth/access';
class CreateUserDto {
  @IsString() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/) username!: string;
  @IsString() @Length(1, 100) name!: string;
  @IsString() @Length(12, 128) password!: string;
  @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) roles!: string[];
}
class UpdateAccessDto {
  @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) roles!: string[];
  @IsBoolean() active!: boolean;
  @IsInt() @Min(1) version!: number;
  @IsString() @Length(1, 500) reason!: string;
}
@Controller('users')
@RequirePermissions('users.manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get() list() {
    return this.users.list();
  }
  @Post() create(@Body() input: CreateUserDto, @Req() request: AuthRequest) {
    return this.users.create(input, request.user);
  }
  @Patch(':id/access') update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateAccessDto,
    @Req() request: AuthRequest,
  ) {
    return this.users.updateAccess(id, input, request.user);
  }
}
