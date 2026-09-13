import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { OnModuleDestroy } from '@nestjs/common';
import { McpService } from './mcp.service';
import { UserCredentialService } from '../auth/user-credential.service';
import { OpenApiRateLimitService } from '../open-api/open-api-rate-limit.service';
import { AuthService } from '../auth/auth.service';
import { getPrismaClient } from '../prisma';

interface McpSession {
  id: string;
  res: Response;
  user: any;
  credential: any;
  createdAt: number;
}

@Controller('mcp')
export class McpController implements OnModuleDestroy {
  private readonly prisma = getPrismaClient();
  private readonly sessions = new Map<string, McpSession>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly mcpService: McpService,
    private readonly userCredentialService: UserCredentialService,
    private readonly rateLimitService: OpenApiRateLimitService,
    private readonly authService: AuthService,
  ) {
    // Periodic session cleanup for stale disconnected sessions
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions.entries()) {
        if (now - session.createdAt > 3600 * 1000 * 4) {
          try {
            session.res.end();
          } catch {}
          this.sessions.delete(id);
        }
      }
    }, 60000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      try {
        session.res.end();
      } catch {}
    }
    this.sessions.clear();
  }

  /**
   * 鉴权辅助方法：支持 X-App-Id/X-App-Secret 请求头、Query 参数以及内部 Bearer Token
   */
  private async authenticate(req: Request): Promise<{ user: any; credential?: any }> {
    const headers = req.headers || {};
    const query: any = req.query || {};

    const appId =
      headers['x-app-id'] ||
      headers['app-id'] ||
      headers['x-appid'] ||
      query.app_id ||
      query.appId;

    const appSecret =
      headers['x-app-secret'] ||
      headers['app-secret'] ||
      headers['x-appsecret'] ||
      query.app_secret ||
      query.appSecret;

    if (appId && appSecret) {
      const verified = await this.userCredentialService.verifyCredential(
        String(appId).trim(),
        String(appSecret).trim(),
      );
      if (!verified) {
        throw new UnauthorizedException({
          code: 401,
          message: 'MCP 鉴权失败：X-App-Id 或 X-App-Secret 不正确或已被禁用',
        });
      }

      const rate = this.rateLimitService.check(String(appId).trim());
      if (!rate.allowed) {
        throw new HttpException(
          {
            code: 429,
            message: `请求过于频繁：该 AppId 每分钟最多 ${this.rateLimitService.limitPerMinute} 次请求，请在 ${rate.retryAfterSec} 秒后重试`,
          },
          429,
        );
      }

      return { user: verified.user, credential: verified.credential };
    }

    // Fallback: Bearer JWT
    const authHeader = String(headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      try {
        const userId = await this.authService.userIdFromRequest(req);
        const user = await this.prisma.user.findUnique({
          where: { id: userId, status: 'active' },
          include: {
            roles: { include: { role: true } },
            orgs: { include: { orgNode: true } },
          },
        });
        if (user) {
          return {
            user: {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              email: user.email,
              roles: user.roles,
              orgs: user.orgs,
            },
          };
        }
      } catch {}
    }

    throw new UnauthorizedException({
      code: 401,
      message: 'MCP 鉴权失败：缺少有效的 X-App-Id 和 X-App-Secret 凭证',
    });
  }

  /**
   * 1. 标准 MCP SSE 连接端点 (Server-Sent Events)
   * 客户端连接此端点建立长连接，接收 endpoint 与后续消息推送
   */
  @Get('sse')
  async connectSse(@Req() req: Request, @Res() res: Response) {
    const { user, credential } = await this.authenticate(req);
    const sessionId = randomUUID();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // 存储当前活跃会话
    const session: McpSession = {
      id: sessionId,
      res,
      user,
      credential,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);

    // 发送标准 MCP endpoint 事件，通知客户端向该地址 POST 消息
    res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);

    // 定时发送心跳保持连接存活
    const keepAliveTimer = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAliveTimer);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      this.sessions.delete(sessionId);
    });
  }

  /**
   * 2. 标准 MCP 消息接收端点 (POST /mcp/messages?sessionId=...)
   * 接收客户端 JSON-RPC 消息并通过 SSE 流或 HTTP 同步响应返回
   */
  @Post('messages')
  @HttpCode(200)
  async postMessage(
    @Req() req: Request,
    @Res() res: Response,
    @Query('sessionId') querySessionId: string,
    @Body() body: any,
  ) {
    const sessionId = querySessionId || req.headers['x-mcp-session-id'] as string;
    let user: any;
    let session: McpSession | undefined;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
      user = session.user;
    } else {
      // 若无活跃会话，尝试直接凭证鉴权
      const auth = await this.authenticate(req);
      user = auth.user;
    }

    const result = await this.mcpService.handleJsonRpc(user, body);

    // 若为无需返回的 Notification，直接返回 202 Accepted
    if (result === null) {
      return res.status(202).send();
    }

    // 1. 若对应 SSE 会话依然存活，通过 SSE event: message 推送
    if (session && !session.res.writableEnded) {
      try {
        session.res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      } catch {}
    }

    // 2. 同时在 HTTP POST 响应体中直接返回，兼容所有单向与双向 MCP 客户端
    return res.status(200).json(result);
  }

  /**
   * 3. 直连无状态 MCP JSON-RPC 端点 (POST /mcp)
   * 适用于直接以 HTTP POST 方式调用 JSON-RPC 2.0 的客户端
   */
  @Post()
  @HttpCode(200)
  async handleDirectRpc(@Req() req: Request, @Body() body: any) {
    const { user } = await this.authenticate(req);
    const result = await this.mcpService.handleJsonRpc(user, body);
    if (result === null) {
      return { ok: true };
    }
    return result;
  }

  /**
   * 4. MCP 服务规范与客户端一键配置元数据接口
   */
  @Get('spec')
  getMcpSpec(@Req() req: Request) {
    const host = req.get('host') || '119.45.22.137:20080';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    return {
      name: 'gbrainkg-mcp',
      description: 'GBrain 知识库 Model Context Protocol (MCP) 服务',
      version: '1.0.0',
      protocolVersion: '2024-11-05',
      endpoints: {
        sse: `${baseUrl}/mcp/sse`,
        messages: `${baseUrl}/mcp/messages`,
        direct_rpc: `${baseUrl}/mcp`,
      },
      auth: {
        type: 'apiKey',
        headers: {
          id: 'X-App-Id',
          secret: 'X-App-Secret',
        },
        query: {
          id: 'app_id',
          secret: 'app_secret',
        },
      },
      tools: this.mcpService.getTools(),
      clientConfigurations: {
        cursor_and_windsurf: {
          description: '适用于 Cursor / Windsurf / VSCode Continue 的 SSE 格式配置',
          config: {
            mcpServers: {
              gbrainkg: {
                url: `${baseUrl}/mcp/sse`,
                headers: {
                  'X-App-Id': 'YOUR_APP_ID',
                  'X-App-Secret': 'YOUR_APP_SECRET',
                },
              },
            },
          },
        },
        claude_desktop: {
          description: '适用于 Claude Desktop (通过 npx mcp-remote 远程桥接)',
          config: {
            mcpServers: {
              gbrainkg: {
                command: 'npx',
                args: [
                  '-y',
                  'mcp-remote',
                  `${baseUrl}/mcp/sse`,
                  '--header',
                  'X-App-Id: YOUR_APP_ID',
                  '--header',
                  'X-App-Secret: YOUR_APP_SECRET',
                ],
              },
            },
          },
        },
      },
    };
  }
}
