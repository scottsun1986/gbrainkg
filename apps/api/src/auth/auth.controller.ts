import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    return this.authService.login(String(body.username || '').trim(), String(body.password || ''));
  }

  @Get('me')
  async me(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    return { userId };
  }
}
