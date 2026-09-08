import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { OpenApiGuard } from './open-api.guard';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { getPrismaClient } from '../prisma';

const R = (code: number, msg: string, data: any = null) => ({
  code,
  msg,
  data,
});

@Controller('open-api')
export class OpenApiController {
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot = process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads';

  constructor(
    private readonly chatService: ChatService,
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    private readonly ingestionService: IngestionService,
  ) {}

  /**
   * 1. 规范元数据接口：返回符合 OpenAPI 3.0.3 的接口定义规范 JSON
   */
  @Get('spec.json')
  getOpenApiSpec(@Req() req: any) {
    const host = req.get('host') || '119.45.22.137:20080';
    const protocol = req.protocol || 'http';
    return {
      openapi: '3.0.3',
      info: {
        title: 'GBrain 知识库对外服务 OpenAPI',
        version: '1.0.0',
        description:
          '对外开放服务接口，通过 X-App-Id / X-App-Secret 请求头进行鉴权。鉴权成功后以绑定的用户身份及对应的知识库权限执行操作。',
      },
      servers: [{ url: `${protocol}://${host}`, description: '当前服务环境' }],
      components: {
        securitySchemes: {
          AppIdAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-App-Id',
            description: '分配给用户的应用标识 (AppId)',
          },
          AppSecretAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-App-Secret',
            description: '分配给用户的应用密钥 (AppSecret)',
          },
        },
        schemas: {
          R: {
            type: 'object',
            description: '统一响应结构：业务成功 code=200；业务失败时返回对应业务码及 msg 失败原因。',
            properties: {
              code: { type: 'integer', example: 200 },
              msg: { type: 'string', example: '操作成功' },
              data: {},
            },
          },
          ChatCompletionRequest: {
            type: 'object',
            required: ['prompt'],
            properties: {
              prompt: { type: 'string', description: '提问内容/用户输入' },
              conversation_id: { type: 'string', description: '会话ID（可选，不传时自动新建会话）' },
              kb_ids: {
                type: 'array',
                items: { type: 'string' },
                description: '检索知识库范围ID列表（可选，默认检索用户有权访问的所有库）',
              },
              stream: { type: 'boolean', description: '是否启用流式返回（默认 false）' },
            },
          },
          SearchRequest: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', description: '搜索关键词或语义问题' },
              kb_ids: { type: 'array', items: { type: 'string' }, description: '知识库范围过滤' },
              top_k: { type: 'integer', default: 10, description: '最大返回片段数' },
            },
          },
        },
      },
      security: [{ AppIdAuth: [], AppSecretAuth: [] }],
      paths: {
        '/open-api/v1/chat/completions': {
          post: {
            summary: '知识问答与智能对话 (Chat Completions)',
            description: '基于用户权限内的知识库进行检索增强问答（RAG），支持流式 SSE 输出或一次性完整回答',
            tags: ['知识问答'],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
                },
              },
            },
            responses: {
              '200': { description: '成功响应', content: { 'application/json': { schema: { $ref: '#/components/schemas/R' } } } },
              '401': { description: '鉴权失败（X-App-Id 或 X-App-Secret 无效）' },
            },
          },
        },
        '/open-api/v1/search': {
          post: {
            summary: '知识库语义与混合检索 (Search)',
            description: '在当前用户有权访问的知识库范围内执行多路召回与混合精排检索',
            tags: ['知识检索'],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SearchRequest' },
                },
              },
            },
            responses: {
              '200': { description: '成功响应' },
              '401': { description: '鉴权失败' },
            },
          },
        },
        '/open-api/v1/knowledge-bases': {
          get: {
            summary: '获取当前可访问的知识库列表',
            description: '返回凭证绑定员工/用户有权限查看的所有个人库、组织库与行业库',
            tags: ['知识库管理'],
            responses: {
              '200': { description: '成功响应' },
              '401': { description: '鉴权失败' },
            },
          },
        },
        '/open-api/v1/documents/upload': {
          post: {
            summary: '上传文档至知识库',
            description: '上传并入库文档（支持 pdf, pptx, docx, txt, md, xlsx 等）',
            tags: ['知识库管理'],
            responses: {
              '200': { description: '上传成功' },
              '401': { description: '鉴权失败' },
            },
          },
        },
        '/open-api/v1/documents/status/{docId}': {
          get: {
            summary: '查询文档入库与解析状态',
            description: '获取指定文档的当前状态及解析质检指标',
            tags: ['知识库管理'],
            responses: {
              '200': { description: '成功响应' },
              '401': { description: '鉴权失败' },
            },
          },
        },
        '/open-api/dict/kb-types': {
          get: {
            summary: '查询知识库类型字典',
            tags: ['字典'],
            responses: { '200': { description: '成功响应' } },
          },
        },
        '/open-api/user/info': {
          get: {
            summary: '查询当前凭证绑定的用户信息',
            tags: ['用户'],
            responses: { '200': { description: '成功响应' } },
          },
        },
      },
    };
  }

  /**
   * 2. 查询当前凭证绑定的用户信息
   */
  @Get('user/info')
  @UseGuards(OpenApiGuard)
  async getUserInfo(@Req() req: any) {
    const user = req.user;
    return R(200, '操作成功', {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      roles: user.roles?.map((r: any) => r.role?.name || r.roleName) || [],
      orgs: user.orgs?.map((o: any) => o.orgNode?.name || o.orgNodeId) || [],
      credential: req.credential,
    });
  }

  /**
   * 3. 知识库类型字典
   */
  @Get('dict/kb-types')
  @UseGuards(OpenApiGuard)
  async getKbTypesDict() {
    return R(200, '操作成功', [
      { code: 'personal', name: '个人知识库' },
      { code: 'org', name: '组织知识库' },
      { code: 'industry', name: '行业知识库' },
    ]);
  }

  /**
   * 4. 知识库列表接口
   */
  @Get('v1/knowledge-bases')
  @UseGuards(OpenApiGuard)
  async listKnowledgeBases(@Req() req: any) {
    const userId = req.user.id;
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const kbs = await this.prisma.knowledgeBase.findMany({
      where: { id: { in: visibleIds }, status: 'active' },
      include: { _count: { select: { documents: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const data = kbs.map((kb) => ({
      id: kb.id,
      name: kb.name,
      type: kb.type,
      description: kb.description,
      document_count: kb._count.documents,
      created_at: kb.createdAt,
      updated_at: kb.updatedAt,
    }));

    return R(200, '操作成功', data);
  }

  /**
   * 5. 知识库语义与混合检索
   */
  @Post('v1/search')
  @UseGuards(OpenApiGuard)
  async searchKnowledge(
    @Req() req: any,
    @Body() body: { query: string; kb_ids?: string[]; top_k?: number },
  ) {
    const userId = req.user.id;
    const query = String(body?.query || '').trim();
    if (!query) throw new BadRequestException('query is required.');

    const limit = Math.max(1, Math.min(Number(body?.top_k || 10) || 10, 50));
    const rawResults = await this.chatService.searchKnowledgeForAgent(
      userId,
      query,
      body?.kb_ids,
      limit,
    );

    return R(200, '操作成功', {
      query,
      total: Array.isArray(rawResults) ? rawResults.length : 0,
      results: rawResults,
    });
  }

  /**
   * 6. 智能对话问答 (Chat Completions)
   * 支持流式 SSE 或一次性 JSON 输出
   */
  @Post('v1/chat/completions')
  @UseGuards(OpenApiGuard)
  async chatCompletions(
    @Req() req: any,
    @Res() res: Response,
    @Body() body: {
      prompt: string;
      conversation_id?: string;
      kb_ids?: string[];
      stream?: boolean;
    },
  ) {
    const userId = req.user.id;
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json(R(400, 'prompt 不能为空'));
    }

    let conversation: any = null;
    if (body.conversation_id) {
      conversation = await this.prisma.conversation.findFirst({
        where: { id: body.conversation_id, userId },
      });
      if (!conversation) {
        return res.status(404).json(R(404, '指定的 conversation_id 不存在或无权访问'));
      }
    } else {
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          title: prompt.slice(0, 80),
        },
      });
    }

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: prompt,
      },
    });

    const wantsStream =
      Boolean(body.stream) ||
      String(req.headers.accept || '').includes('text/event-stream');

    const stream$ = await this.chatService.handleChatStream(
      userId,
      prompt,
      body.kb_ids,
      conversation.id,
    );

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      let accumulated = '';
      const sub = stream$.subscribe({
        next: (event: any) => {
          const item = event?.data || event;
          if (item?.type === 'token') {
            accumulated += item.content || item.token || '';
            res.write(`data: ${JSON.stringify({ type: 'token', content: item.content || item.token })}\n\n`);
          } else if (item?.type === 'citations') {
            res.write(`data: ${JSON.stringify({ type: 'citations', citations: item.citations })}\n\n`);
          } else if (item?.type === 'trace') {
            res.write(`data: ${JSON.stringify({ type: 'trace', node: item.node })}\n\n`);
          }
        },
        error: (err: any) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: err?.message || 'Chat error',
            })}\n\n`,
          );
          res.end();
        },
        complete: () => {
          res.write(
            `data: ${JSON.stringify({
              type: 'done',
              conversation_id: conversation.id,
              full_content: accumulated,
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        },
      });

      req.on('close', () => sub.unsubscribe());
      return;
    }

    // Non-streaming response: collect all tokens and citations
    return new Promise<void>((resolve) => {
      let accumulatedAnswer = '';
      let citations: any[] = [];
      let processingTrace: any = null;

      stream$.subscribe({
        next: (event: any) => {
          const item = event?.data || event;
          if (item?.type === 'token') {
            accumulatedAnswer += item.content || item.token || '';
          } else if (item?.type === 'citations') {
            citations = item.citations || [];
          } else if (item?.type === 'trace') {
            processingTrace = item.node || null;
          }
        },
        error: (err: any) => {
          res.status(500).json(R(500, err?.message || '生成回答失败'));
          resolve();
        },
        complete: () => {
          res.status(200).json(
            R(200, '操作成功', {
              conversation_id: conversation.id,
              answer: accumulatedAnswer,
              citations,
              processing_trace: processingTrace,
            }),
          );
          resolve();
        },
      });
    });
  }

  /**
   * 7. 上传文档至知识库
   */
  @Post('v1/documents/upload')
  @UseGuards(OpenApiGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }),
  )
  async uploadDocument(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body() body: { kb_id?: string; kbId?: string },
  ) {
    const userId = req.user.id;
    const kbId = body.kb_id || body.kbId;
    if (!kbId) throw new BadRequestException('kb_id is required.');
    if (!file) throw new BadRequestException('file is required.');

    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, type: true, ownerUserId: true, status: true },
    });
    if (!kb || kb.status !== 'active') {
      throw new NotFoundException('知识库不存在或已被禁用');
    }

    const canWrite = await this.permissionService.canManageKnowledgeBase(userId, kbId);
    if (!canWrite) {
      throw new ForbiddenException('当前凭证无权向该知识库上传文档');
    }

    const documentId = randomUUID();
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safeExt = extname(originalName).toLowerCase();
    const destDir = join(this.uploadRoot, documentId);
    await fs.mkdir(destDir, { recursive: true });
    const localFilePath = join(destDir, `raw${safeExt}`);
    await fs.writeFile(localFilePath, file.buffer);

    const doc = await this.prisma.document.create({
      data: {
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title: originalName,
        sourceType: 'upload',
        rawFileOid: localFilePath,
        version: 1,
        uploadedById: userId,
        status: 'parsing',
        qualityStatus: 'pending',
      },
    });

    // Enqueue ingestion
    await this.ingestionService.enqueue(doc.id, 'upload', doc.version);

    return R(200, '文件上传成功，已提交解析流水线', {
      document_id: doc.id,
      title: doc.title,
      status: doc.status,
      kb_id: doc.kbId,
    });
  }

  /**
   * 8. 查询文档状态
   */
  @Get('v1/documents/status/:docId')
  @UseGuards(OpenApiGuard)
  async getDocumentStatus(@Req() req: any, @Param('docId') docId: string) {
    const userId = req.user.id;
    const doc = await this.prisma.document.findUnique({
      where: { id: docId },
      include: { kb: { select: { id: true, name: true } } },
    });
    if (!doc) throw new NotFoundException('文档不存在');

    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(doc.kbId)) {
      throw new ForbiddenException('无权访问该文档状态');
    }

    return R(200, '操作成功', {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      quality_status: doc.qualityStatus,
      parser_engine: doc.parserEngine,
      quality_issues: doc.qualityIssues,
      kb: doc.kb,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
  }
}
