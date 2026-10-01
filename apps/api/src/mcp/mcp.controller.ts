import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { OnModuleDestroy } from '@nestjs/common';
import { McpService } from './mcp.service';
import { UserCredentialService } from '../auth/user-credential.service';
import { OpenApiRateLimitService } from '../open-api/open-api-rate-limit.service';
import { AuthService } from '../auth/auth.service';
import { setRequestContextUser, getRequestContext } from '../observability/request-context';
import { getPrismaClient } from '../prisma';
import { withAuthorizedRequest, assertAuthorizationSnapshot, authorizationEnforced, AuthorizationSnapshot } from '../permission/authorization-revision';
import { withStrictOutputPermit } from '../permission/strict-output-permit';

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

  private async withRpcRequest<T>(userId: string, res: Response, work: (snapshot: AuthorizationSnapshot) => Promise<T>): Promise<T> {
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1' && !authorizationEnforced()) throw new BadRequestException('Strict output requires authorization enforcement');
    return withAuthorizedRequest(userId,async snapshot => {
      const cancellation = new AbortController();
      getRequestContext()!.cancellation = cancellation.signal;
      const disconnected = () => { if (!res.writableFinished) cancellation.abort(new Error('MCP transport disconnected')); };
      res.once?.('close',disconnected);
      try { return await work(snapshot); }
      finally { res.off?.('close',disconnected); }
    });
  }

  private async emitAuthorized(userId: string, snapshot: AuthorizationSnapshot, emit: () => Promise<void>) {
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') return withStrictOutputPermit(userId,snapshot,emit);
    await assertAuthorizationSnapshot(userId,snapshot);
    return emit();
  }

  /** Hold a strict permit until the transport accepts its complete buffer. */
  private async drain(res: Response, emit: () => unknown): Promise<void> {
    if (res.writableEnded) throw new Error('Transport closed');
    return new Promise((resolve,reject) => {
      const cleanup = () => { clearTimeout(timer);res.off('finish',done);res.off('drain',done);res.off('error',fail);res.off('close',closed); };
      const done = () => { cleanup();resolve(); };
      const fail = (error: Error) => { cleanup();reject(error); };
      const closed = () => res.writableFinished ? done() : fail(new Error('Transport disconnected'));
      const timer = setTimeout(() => fail(new Error('Transport drain timeout')),5000);
      res.once('finish',done);res.once('error',fail);res.once('close',closed);
      try {
        const accepted = emit();
        if (res.writableFinished || accepted === true || res.writableLength === 0) done();
        else if (!res.writableEnded) res.once('drain',done);
      } catch (error) { fail(error as Error); }
    });
  }

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
      headers['x-appid'];

    const appSecret =
      headers['x-app-secret'] ||
      headers['app-secret'] ||
      headers['x-appsecret'];

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

      // 凭证鉴权不经过 AuthService.userIdFromRequest，必须显式把用户写入请求
      // 上下文，否则 RLS 事务会以空 user_id + service=off 作用域执行，
      // 导致 Conversation/Message 等写入触发 "row-level security policy" 42501。
      setRequestContextUser(verified.user.id);

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
        const rate = this.rateLimitService.check(userId);
        if (!rate.allowed) {
          throw new HttpException(
            {
              code: 429,
              message: `请求过于频繁：每分钟最多 ${this.rateLimitService.limitPerMinute} 次请求，请在 ${rate.retryAfterSec} 秒后重试`,
            },
            429,
          );
        }
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

    return this.withRpcRequest(user.id,res, async snapshot => {
      const result = await this.mcpService.handleJsonRpc(user, body);
      if (result === null) return res.status(202).send();
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new BadRequestException('MCP output buffer capacity exceeded');
      await this.emitAuthorized(user.id,snapshot,async () => {
        if (session && !session.res.writableEnded) {
          const event = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
          if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') await this.drain(session.res,() => session!.res.write(event));
          else session.res.write(event);
        }
        if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') await this.drain(res,() => res.status(200).json(result));
        else res.status(200).json(result);
      });
    });
  }

  /**
   * 3. Streamable HTTP / JSON-RPC 通用端点 (POST /mcp 与 POST /mcp/stream)
   * 支持标准 MCP Streamable HTTP 协议：
   * - 客户端若提供 Accept: text/event-stream 或 body.stream=true，采用 Transfer-Encoding: chunked / SSE 渐进式流式返回；
   * - 工具调用（如 chat_knowledge）可流式推送中间 token/进度，最后推送完整 JSON-RPC 结果；
   * - 普通 JSON 请求直接返回标准 JSON-RPC 2.0 响应。
   */
  @Post()
  @HttpCode(200)
  async handleDirectRpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: any,
  ) {
    return this.processStreamableRpc(req, res, body, false);
  }

  @Post('stream')
  @HttpCode(200)
  async handleStreamEndpoint(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: any,
  ) {
    return this.processStreamableRpc(req, res, body, true);
  }

  private async processStreamableRpc(
    req: Request,
    res: Response,
    body: any,
    forceStream = false,
  ) {
    const { user } = await this.authenticate(req);
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1' && !authorizationEnforced()) throw new BadRequestException('Strict output requires authorization enforcement');
    return this.withRpcRequest(user.id,res,async snapshot => {
    const strict = process.env.KNOWLEDGE_STRICT_OUTPUT === '1';
    const acceptHeader = String(req.headers['accept'] || '').toLowerCase();
    const isStreamRequested =
      forceStream ||
      acceptHeader.includes('text/event-stream') ||
      acceptHeader.includes('application/x-ndjson') ||
      body?.stream === true;

    if (isStreamRequested) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const reqId = body?.id ?? null;

      try {
        const result = await this.mcpService.handleJsonRpc(user, body, strict ? undefined : (progressEvent: any) => {
          if (res.writableEnded) return;
          if (progressEvent?.type === 'token') {
            const payload = {
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: {
                delta: progressEvent.delta,
                conversation_id: progressEvent.conversation_id,
              },
            };
            res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          } else if (progressEvent?.type === 'progress') {
            const payload = {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                phase: progressEvent.phase,
                message: progressEvent.message,
              },
            };
            res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
          } else if (progressEvent?.type === 'citation') {
            const payload = {
              jsonrpc: '2.0',
              method: 'notifications/citation',
              params: progressEvent.citation,
            };
            res.write(`event: citation\ndata: ${JSON.stringify(payload)}\n\n`);
          }
        });

        if (result !== null && !res.writableEnded) {
          const event = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
          if (Buffer.byteLength(event) > 8 * 1024 * 1024) throw new BadRequestException('MCP output buffer capacity exceeded');
          await this.emitAuthorized(user.id,snapshot,async () => {
            if (strict) await this.drain(res,() => { res.write(event);res.end(); });
            else res.write(event);
          });
        }
      } catch (err: any) {
        if (!res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: reqId,
              error: { code: -32603, message: err?.message || 'Internal Streamable HTTP error' },
            })}\n\n`,
          );
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    const result = await this.mcpService.handleJsonRpc(user, body);
    if (result === null) return res.status(202).send();
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new BadRequestException('MCP output buffer capacity exceeded');
    await this.emitAuthorized(user.id,snapshot,async () => {
      if (strict) await this.drain(res,() => res.status(200).json(result));
      else res.status(200).json(result);
    });
    });
  }

  /**
   * 3b. 文件直传端点 (POST /mcp/upload)
   * 以 multipart/form-data 直接上传原始文件（无需 Base64 编码），
   * 鉴权、限流、知识库权限校验与 MCP 工具体系一致，
   * 上传后同样进入后台解析流水线。
   * 表单字段: file(必填, 文件), kb_id(必填), title(可选)
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 200 * 1024 * 1024 },
    }),
  )
  async uploadFile(
    @Req() req: Request,
    @Query('kb_id') kbIdQuery: string,
    @Body('kb_id') kbIdBody: string,
    @Body('title') title: string,
    @UploadedFile() file: any,
  ) {
    const { user } = await this.authenticate(req);
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        '缺少文件：请以 multipart/form-data 提交，文件字段名为 file',
      );
    }
    // kb_id 支持表单字段或 URL 查询参数两种形式，兼容部分代理/客户端
    // 转发 multipart 文本字段时的丢字段问题。
    const kbId = String(kbIdBody || kbIdQuery || '').trim();
    if (!kbId) {
      throw new BadRequestException('缺少 kb_id（表单字段或 ?kb_id= 均可）');
    }
    // Multer 兼容问题：非 ASCII 文件名默认按 latin1 解码，此处还原为 UTF-8
    const filename = Buffer.from(file.originalname || '', 'latin1').toString('utf8');
    if (!filename.trim()) {
      throw new BadRequestException('文件名缺失（文件须包含扩展名）');
    }
    try {
      const result = await this.mcpService.saveUploadAndEnqueue(user.id, {
        kbId,
        filename,
        fileBuffer: file.buffer,
        title: title ? String(title) : undefined,
      });
      return result;
    } catch (err: any) {
      const message = String(err?.message || '上传失败');
      if (message.includes('无权')) throw new ForbiddenException(message);
      if (message.includes('不存在')) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  /**
   * 4. MCP 服务规范与客户端一键配置元数据接口
   */
  @Get('spec')
  getMcpSpec(@Req() req: Request) {
    const xForwardedHost = req.get('x-forwarded-host');
    const xForwardedProto = req.get('x-forwarded-proto');
    let host = xForwardedHost || req.get('host') || 'knowledge.5gsailor.com:20080';
    let protocol = xForwardedProto || req.protocol || 'https';

    // 强制生产域名携带对外服务的 20080 端口
    if (host.includes('knowledge.5gsailor.com') && !host.includes(':')) {
      host = 'knowledge.5gsailor.com:20080';
      protocol = 'https';
    }
    const baseUrl = `${protocol}://${host}`;

    return {
      name: 'gbrainkg-mcp',
      description: 'GBrain 知识库 Model Context Protocol (MCP) 服务 (支持 Streamable HTTP 与 SSE)',
      version: '1.1.0',
      protocolVersion: '2024-11-05',
      transports: ['streamable-http', 'sse', 'direct-rpc'],
      endpoints: {
        streamable_http: `${baseUrl}/mcp`,
        stream: `${baseUrl}/mcp/stream`,
        upload_file: `${baseUrl}/mcp/upload`,
        sse: `${baseUrl}/mcp/sse`,
        messages: `${baseUrl}/mcp/messages`,
        direct_rpc: `${baseUrl}/mcp`,
      },
      upload: {
        method: 'POST',
        url: `${baseUrl}/mcp/upload`,
        contentType: 'multipart/form-data',
        fields: { file: '(必填) 原始文件二进制', kb_id: '(必填) 目标知识库 ID', title: '(可选) 文档标题' },
        maxSizeBytes: 200 * 1024 * 1024,
        curlExample: `curl -X POST ${baseUrl}/mcp/upload -H "X-App-Id: YOUR_APP_ID" -H "X-App-Secret: YOUR_APP_SECRET" -F "file=@report.pdf" -F "kb_id=TARGET_KB_ID"`,
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
        streamable_http: {
          description: '适用于 Cursor / Windsurf 的 Streamable HTTP 标准配置（推荐）',
          config: {
            mcpServers: {
              gbrainkg: {
                url: `${baseUrl}/mcp`,
                headers: {
                  'X-App-Id': 'YOUR_APP_ID',
                  'X-App-Secret': 'YOUR_APP_SECRET',
                },
              },
            },
          },
        },
        cursor_and_windsurf_sse: {
          description: '适用于 Cursor / Windsurf / VSCode Continue 的传统 SSE 格式配置',
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
          description: '适用于 Claude Desktop (通过 npx mcp-remote 远程桥接 Streamable HTTP)',
          config: {
            mcpServers: {
              gbrainkg: {
                command: 'npx',
                args: [
                  '-y',
                  'mcp-remote',
                  `${baseUrl}/mcp`,
                  '--header',
                  'X-App-Id: YOUR_APP_ID',
                  '--header',
                  'X-App-Secret: YOUR_APP_SECRET',
                ],
              },
            },
          },
        },
        dify_and_orchestrators: {
          description: '适用于 Dify / Open WebUI 等 Agent 编排平台的 Streamable HTTP 端点配置',
          config: {
            server_url: `${baseUrl}/mcp`,
            transport: 'streamable-http',
            headers: {
              'X-App-Id': 'YOUR_APP_ID',
              'X-App-Secret': 'YOUR_APP_SECRET',
            },
          },
        },
      },
    };
  }
}
