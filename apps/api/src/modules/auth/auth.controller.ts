import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { IsString, Length, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public, type AuthRequest } from './access';
import { sessionCookie } from './auth.guard';
class LoginDto {
  @IsString() @Length(3, 64) username!: string;
  @IsString() @Length(1, 128) @MaxLength(128) password!: string;
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() input: LoginDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, user } = await this.auth.login(
      input.username,
      input.password,
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
      sessionCookie(request.headers.cookie),
    );
    response.cookie('dukanos_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return user;
  }
  @Get('me') me(@Req() request: AuthRequest) {
    return request.user;
  }
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(request.sessionHash);
    response.clearCookie('dukanos_session', {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
    });
  }
}
