import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
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
  // 登录语义是"验证成功"而非"创建资源"，返回 200（而非 POST 默认的
  // 201），与标准 MCP/OpenAPI 客户端及 E2E 套件的状态码断言保持一致。
  @HttpCode(200)
  async login(@Body() body: { username?: string; password?: string }) {
    const username = String(body?.username || "").trim();
    try {
      const result = await this.authService.login(
        username,
        String(body?.password || ""),
      );
      // MFA second-factor / forced-setup responses carry no user yet — audit
      // those at the mfa endpoints instead.
      const userId = (result as any).user?.id;
      if (userId) {
        this.auditService
          .log({
            userId,
            action: "login",
            resource: "auth",
            details: { username },
          })
          .catch(() => undefined);
      }
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
      select: { id: true, username: true, displayName: true, email: true, mustChangePassword: true, mfaEnabled: true, source: true },
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
