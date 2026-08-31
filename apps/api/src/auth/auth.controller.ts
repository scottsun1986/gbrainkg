import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";

@Controller("api/v1/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({
    default: {
      limit: Number(process.env.AUTH_LOGIN_THROTTLE_LIMIT || 10),
      ttl: 60000,
    },
  })
  @Post("login")
  login(@Body() body: { username?: string; password?: string }) {
    return this.authService.login(
      String(body.username || "").trim(),
      String(body.password || ""),
    );
  }

  @UseGuards(AuthGuard)
  @Get("me")
  async me(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    return { userId };
  }
}
