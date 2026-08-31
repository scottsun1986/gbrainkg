import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";

@Controller("api/v1/auth")
export class AuthController {
  private readonly prisma = new PrismaClient();

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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, mustChangePassword: true },
    });
    return { userId, user };
  }

  @UseGuards(AuthGuard)
  @Post("change-password")
  async changePassword(
    @Req() req: any,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.authService.changePassword(
      userId,
      String(body.currentPassword || ""),
      String(body.newPassword || ""),
    );
  }
}
