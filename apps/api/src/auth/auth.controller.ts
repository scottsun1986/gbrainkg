import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { getPrismaClient } from "../prisma";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";
import { AuditService } from "../audit/audit.service";

@Controller("api/v1/auth")
export class AuthController {
  private readonly prisma = getPrismaClient();

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  @Throttle({
    default: {
      limit: Number(process.env.AUTH_LOGIN_THROTTLE_LIMIT || 10),
      ttl: 60000,
    },
  })
  @Post("login")
  async login(@Body() body: { username?: string; password?: string }) {
    const username = String(body?.username || "").trim();
    try {
      const result = await this.authService.login(
        username,
        String(body?.password || ""),
      );
      this.auditService
        .log({
          userId: result.user.id,
          action: "login",
          resource: "auth",
          details: { username },
        })
        .catch(() => undefined);
      return result;
    } catch (error) {
      this.auditService
        .log({
          userId: username,
          action: "login_failed",
          resource: "auth",
          details: { username },
        })
        .catch(() => undefined);
      throw error;
    }
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
