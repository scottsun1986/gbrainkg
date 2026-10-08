import { withAuthorizedRequest, authorizationEnforced } from '../permission/authorization-revision';
import { withStrictOutputPermit, withStrictResourceOutput } from '../permission/strict-output-permit';
import { getRequestContext } from '../observability/request-context';
import { parseAsOf } from '../retrieval/as-of';
import { ExternalChatEventReducer } from '../chat/external-chat-events';
import { KnowledgeOperationsService, KnowledgeResource } from '../ingestion/knowledge-operations.service';
import { validateKnowledgeToolArguments } from '../mcp/knowledge-tool-schema';
import { withServiceContext } from '../db/tenant-context.service';
import { uploadRoot } from '../storage/upload-paths';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Delete,
  Optional,
  ServiceUnavailableException,
  Logger,
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
import { completeOpenApiSpec } from './open-api-spec';
import { OpenApiGuard } from './open-api.guard';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../ingestion/parser-capabilities';
import { BrainCompilerService } from '../brain-compiler/brain-compiler.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { isArchiveFilename } from '../ingestion/parser-capabilities';
import { extractArchiveDocuments } from '../ingestion/archive-extractor';
import { getPrismaClient } from '../prisma';

const R = (code: number, msg: string, data: any = null) => ({
  code,
  msg,
  data,
});

@Controller('open-api')
export class OpenApiController {
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot = uploadRoot();
  private readonly logger = new Logger(OpenApiController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly permissionService: PermissionService,
    private readonly compilerService: BrainCompilerService,
    private readonly ingestionService: IngestionService,
    @Optional() private readonly operations?: KnowledgeOperationsService,
  ) {}

  /**
   * 1. 规范元数据接口：返回符合 OpenAPI 3.0.3 的接口定义规范 JSON
   */
  @Get('spec.json')
  getOpenApiSpec(@Req() req: any) {
    const host = req.get('host') || 'localhost';
    const protocol = req.protocol || 'http';
    const serverUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || `${protocol}://${host}`;
    return completeOpenApiSpec({
      openapi: '3.0.3',
      info: {
        title: 'GBrain 知识库对外服务 OpenAPI',
        version: '1.0.0',
        description:
          '对外开放服务接口，通过 X-App-Id / X-App-Secret 请求头进行鉴权。鉴权成功后以绑定的用户身份及对应的知识库权限执行操作。',
      },
      servers: [{ url: serverUrl, description: '当前服务环境' }],
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
    });
  }

  /**
   * 2. 查询当前凭证绑定的用户信息
   */
  @Get('user/info')
  @UseGuards(OpenApiGuard)
  async getUserInfo(@Req() req: any, @Res() res: Response) {
    return this.resourceResponse(req.user.id, res, async tx => ({
      ...await this.knowledgeOperations().readResource(req.user.id, { kind: 'user_info', args: {} }, tx),
      credential: req.credential,
    }));
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
  async listKnowledgeBases(@Req() req: any, @Res() res: Response, @Query() query: Record<string, any> = {}) {
    const args = this.resourceArgs('list_knowledge_bases', query);
    return this.resourceResponse(req.user.id, res, async tx => {
      const result = await this.knowledgeOperations().readResource(req.user.id, { kind: 'knowledge_bases', args }, tx);
      return query.limit !== undefined || query.offset !== undefined ? result : result.knowledge_bases;
    });
  }

  /**
   * 5. 知识库语义与混合检索
   */
  @Post('v1/search')
  @HttpCode(200)
  @UseGuards(OpenApiGuard)
  async searchKnowledge(
    @Req() req: any,
    @Body() body: { query: string; kb_ids?: string[] | string; top_k?: number; asOf?: string },
    @Res() res: Response,
  ) {
    const userId = req.user.id;
    if (typeof body?.query !== 'string' || !body.query.trim() || body.query.length > 10000) throw new BadRequestException('query must be a nonempty string of at most 10000 characters.');
    const scope = this.parseKbScope(body.kb_ids);
    const searchArgs = { ...body, ...(body.kb_ids === undefined ? {} : { kb_ids: scope ?? 'all' }) };
    validateKnowledgeToolArguments('retrieve', searchArgs);
    const limit = body.top_k ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('top_k must be an integer between 1 and 50.');
    this.requireStrictAuthorization();
    return withAuthorizedRequest(userId, async snapshot => {
      this.applyAsOf(body.asOf);
      const rawResults = await this.chatService.searchKnowledgeForAgent(userId, body.query.trim(), scope, limit);
      const payload = R(200, '操作成功', { query: body.query.trim(), total: rawResults.total, results: rawResults.results });
      if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') {
        if (!rawResults.results.length) {
          await withStrictResourceOutput(userId, snapshot, async tx => {
            const visible = await this.permissionService.getVisibleKnowledgeBases(userId, tx);
            if (scope?.some(id => !visible.includes(id))) throw new ForbiddenException('无权访问指定知识库');
            return { ...payload, data: { ...payload.data, exhaustive: false } };
          }, result => this.drainStrictResponse(res, () => res.status(200).json(result)));
        } else await withStrictOutputPermit(userId, snapshot,
          () => this.drainStrictResponse(res, () => res.status(200).json(payload)), (rawResults as any).dependencyManifest);
      } else res.status(200).json(payload);
    });
  }

  private applyAsOf(value: unknown): void {
    if (value === undefined) return;
    const ctx = getRequestContext();
    if (ctx) { ctx.asOf = parseAsOf(value); ctx.asOfExplicit = true; }
  }

  private requireStrictAuthorization(): void {
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1' && !authorizationEnforced()) throw new BadRequestException('Strict output requires authorization enforcement');
  }

  private requireUuid(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException(`${label} must be a UUID.`);
    }
  }

  private parseKbScope(value: unknown): string[] | undefined {
    if (value === undefined || value === 'all') return undefined;
    const ids = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new BadRequestException('kb_ids must contain 1 to 100 UUIDs, or be all.');
    for (const id of ids) this.requireUuid(id, 'kb_ids');
    return [...new Set(ids)];
  }

  private async resourceResponse(userId: string, res: Response, read: (tx: any) => Promise<any>): Promise<void> {
    this.requireStrictAuthorization();
    return withAuthorizedRequest(userId, async snapshot => {
      if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') {
        await withStrictResourceOutput(userId, snapshot, read,
          data => this.drainStrictResponse(res, () => res.status(200).json(R(200, '操作成功', data))));
      } else res.status(200).json(R(200, '操作成功', await read(this.prisma)));
    });
  }

  /**
   * 6. 智能对话问答 (Chat Completions)
   * 支持流式 SSE 或一次性 JSON 输出
   */
  private async drainStrictResponse(res: Response, emit: () => unknown): Promise<void> {
    if (res.writableEnded) throw new Error('Transport closed');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); res.off('finish', done); res.off('error', fail); res.off('close', closed); };
      const done = () => { cleanup(); resolve(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const closed = () => res.writableFinished ? done() : fail(new Error('Transport disconnected'));
      const timer = setTimeout(() => fail(new Error('Transport drain timeout')), 5_000);
      res.once('finish', done); res.once('error', fail); res.once('close', closed);
      try { emit(); if (res.writableFinished) done(); } catch (error) { fail(error as Error); }
    });
  }

  @Post('v1/chat/completions')
  @UseGuards(OpenApiGuard)
  async chatCompletions(
    @Req() req: any,
    @Res() res: Response,
    @Body() body: {
      prompt: string;
      conversation_id?: string;
      kb_ids?: string[] | string;
      stream?: boolean;
      asOf?: string;
    },
  ) {
    const userId = req.user.id;
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === "1" && !authorizationEnforced()) throw new BadRequestException("Strict output requires authorization enforcement");
    return withAuthorizedRequest(userId, async snapshot => {
    if (typeof body?.prompt !== 'string') throw new BadRequestException('prompt must be a string.');
    const prompt = body.prompt.trim();
    if (!prompt) {
      return res.status(400).json(R(400, 'prompt 不能为空'));
    }
    if (prompt.length > 10000) {
      return res.status(400).json(R(400, 'prompt 长度不能超过 10000 字符'));
    }

    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BadRequestException('stream must be boolean.');
    const requested = this.parseKbScope(body.kb_ids);
    const { stream: _stream, ...chatArgs } = body;
    validateKnowledgeToolArguments('chat_knowledge', { ...chatArgs, ...(body.kb_ids === undefined ? {} : { kb_ids: requested ?? 'all' }) });
    this.applyAsOf(body.asOf);
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (requested && requested.some(id => !visibleKbs.includes(id))) throw new ForbiddenException('无权访问指定知识库');
    let conversation: any = null;
    let effectiveKbIds: string[];
    if (body.conversation_id) {
      this.requireUuid(body.conversation_id, 'conversation_id');
      conversation = await this.prisma.conversation.findFirst({ where: { id: body.conversation_id, userId } });
      if (!conversation) throw new NotFoundException('指定的 conversation_id 不存在或无权访问');
      effectiveKbIds = requested ?? (Array.isArray(conversation.kbScope)
        ? conversation.kbScope.filter((id: string) => visibleKbs.includes(id)) : visibleKbs);
    } else {
      effectiveKbIds = requested ?? visibleKbs;
    }
    if (!effectiveKbIds.length) throw new ForbiddenException('本次知识库范围已无可访问资源');

    conversation = await withServiceContext(this.prisma, async tx => {
      const target = conversation || await tx.conversation.create({
        data: { userId, title: prompt.slice(0, 80), kbScope: effectiveKbIds },
      });
      await tx.message.create({ data: { conversationId: target.id, role: 'user', content: prompt } });
      return target;
    });

    const wantsStream =
      Boolean(body.stream) ||
      String(req.headers?.accept || '').includes('text/event-stream');

    const requestStartedAt = Date.now();
    const stream$ = await this.chatService.handleChatStream(
      userId,
      prompt,
      effectiveKbIds,
      conversation.id,
    );

    const strict = process.env.KNOWLEDGE_STRICT_OUTPUT === '1';
    const state = new ExternalChatEventReducer();
    const frames: string[] = [];
    let bytes = 0;
    if (wantsStream && !strict) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let subscription: any;
        let stopped = false;
        const disconnected = () => { stopped = true; subscription?.unsubscribe(); reject(new Error('Transport disconnected')); };
        res.once('close', disconnected);
        const cleanup = () => res.off('close', disconnected);
        subscription = stream$.subscribe({
          next: (event: any) => {
            if (stopped) return;
            const frame = state.consume(event);
            if (!frame) return;
            if (state.failure) { frames.length = 0; return; }
            const encoded = `data: ${JSON.stringify(frame)}\n\n`;
            if (strict) {
              bytes += Buffer.byteLength(encoded);
              if (bytes > 8 * 1024 * 1024) {
                stopped = true; subscription?.unsubscribe(); cleanup();
                reject(new BadRequestException('OpenAPI output buffer capacity exceeded')); return;
              }
              frames.push(encoded);
            } else if (wantsStream) res.write(encoded);
          },
          error: (error: Error) => { cleanup(); reject(error); },
          complete: () => { cleanup(); resolve(); },
        });
        if (stopped) subscription.unsubscribe();
      });
      state.assertSuccessful();
      const persistAndEmit = async () => {
        await this.prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: state.answer,
          citationsSummary: state.citationEnvelopes, dependencyManifest: state.dependencyManifest as any,
          processingTrace: [...state.traceNodes.values()], latencyMs: Date.now() - requestStartedAt } });
        if (wantsStream) {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
          }
          const done = `data: ${JSON.stringify({ type: 'done', conversation_id: conversation.id, full_content: state.answer })}\n\n`;
          if (strict) await this.drainStrictResponse(res, () => res.end(frames.join('') + done + 'data: [DONE]\n\n'));
          else res.end(done + 'data: [DONE]\n\n');
        } else {
          const payload = R(200, '操作成功', { conversation_id: conversation.id, answer: state.answer,
            citations: state.citations, processing_trace: [...state.traceNodes.values()] });
          if (strict) await this.drainStrictResponse(res, () => res.status(200).json(payload));
          else res.status(200).json(payload);
        }
      };
      if (strict) await withStrictOutputPermit(userId, snapshot, persistAndEmit, state.dependencyManifest);
      else await persistAndEmit();
    } catch (error: any) {
      const status = error?.getStatus?.();
      if ([400, 403, 503].includes(status) && !state.failure) throw error;
      if (res.destroyed || res.writableEnded) return;
      state.fail();
      const failAndEmit = async () => {
        await this.prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: state.failure!,
          citationsSummary: [], processingTrace: [], dependencyManifest: state.dependencyManifest as any,
          latencyMs: Date.now() - requestStartedAt } });
        if (wantsStream) {
          if (!res.headersSent) res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          const failure = `data: ${JSON.stringify({ type: 'error', error: state.failure })}\n\n`;
          if (strict) await this.drainStrictResponse(res, () => res.end(failure)); else res.end(failure);
        } else if (strict) await this.drainStrictResponse(res, () => res.status(503).json(R(503, state.failure!)));
        else res.status(503).json(R(503, state.failure!));
      };
      if (strict) await withStrictOutputPermit(userId, snapshot, failAndEmit, state.dependencyManifest);
      else await failAndEmit();
    }
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
    @Res() res: Response,
  ) {
    const userId = req.user.id;
    this.requireStrictAuthorization();
    const kbId = body.kb_id || body.kbId;
    this.requireUuid(kbId, 'kb_id');
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

    const rawName = Buffer.from(file.originalname, 'latin1');
    const utf8Name = rawName.toString('utf8');
    const latin1Name = rawName.toString('latin1');
    const originalName = /[\uFFFD]/.test(utf8Name) ? latin1Name : utf8Name;

    if (isArchiveFilename(originalName)) {
      const extractedFiles = await extractArchiveDocuments(file.buffer, originalName);
      // Validate every entry before writing any of them. Checking inside the
      // write loop left earlier entries already written, inserted and enqueued
      // when a later one was rejected, so a mixed archive returned 400 while
      // partially ingesting into the knowledge base.
      if (extractedFiles.some((item) => !SUPPORTED_UPLOAD_EXTENSIONS.has(extname(item.filename).toLowerCase()))) {
        throw new BadRequestException("Unsupported archive entry type");
      }
      const createdDocs = [];
      for (const item of extractedFiles) {
        const childDocId = randomUUID();
        const safeExt = extname(item.filename).toLowerCase();
        const destDir = join(this.uploadRoot, childDocId);
        await fs.mkdir(destDir, { recursive: true });
        const localFilePath = join(destDir, `raw${safeExt}`);
        await fs.writeFile(localFilePath, item.buffer);

        const childDoc = await this.prisma.document.create({
          data: {
            id: childDocId,
            kbId,
            mdPath: `${childDocId}/content.md`,
            title: item.filename,
            sourceType: 'upload',
            rawFileOid: localFilePath,
            version: 1,
            uploadedById: userId,
            status: 'parsing',
            qualityStatus: 'pending',
          },
        });
        await this.ingestionService.enqueue(childDoc.id, 'upload', childDoc.version);
        createdDocs.push(childDoc);
      }

      return this.uploadResponse(userId, kbId, res, R(200, `压缩包上传成功，已解压并提交 ${createdDocs.length} 篇文档至解析流水线`, {
        document_id: createdDocs[0]?.id,
        documents: createdDocs.map((d) => ({
          document_id: d.id,
          title: d.title,
          status: d.status,
          kb_id: d.kbId,
        })),
        total: createdDocs.length,
        kb_id: kbId,
      }));
    }

    const documentId = randomUUID();
    const safeExt = extname(originalName).toLowerCase();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(safeExt)) {
      return res.status(400).json(R(400, `不支持的文件类型: ${safeExt}`));
    }
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

    return this.uploadResponse(userId, kbId, res, R(200, '文件上传成功，已提交解析流水线', {
      document_id: doc.id,
      title: doc.title,
      status: doc.status,
      kb_id: doc.kbId,
    }));
  }

  /**
   * 8. 查询文档状态
   */
  @Get('v1/documents/status/:docId')
  @UseGuards(OpenApiGuard)
  async getDocumentStatus(@Req() req: any, @Param('docId') docId: string, @Res() res: Response) {
    const args = this.resourceArgs('get_document_status', { doc_id: docId });
    return this.resourceResponse(req.user.id, res, tx => this.knowledgeOperations().readResource(req.user.id, { kind: 'document_status', args }, tx));
  }

  private async uploadResponse(userId: string, kbId: string, res: Response, payload: any): Promise<void> {
    if (process.env.KNOWLEDGE_STRICT_OUTPUT !== '1') { res.status(200).json(payload); return; }
    const args = { action: 'upload_document', kb_id: kbId, ...(Array.isArray(payload.data.documents)
      ? { doc_ids: payload.data.documents.map((document: any) => document.document_id) }
      : { doc_id: payload.data.document_id }) };
    await withAuthorizedRequest(userId, snapshot => withStrictResourceOutput(userId, snapshot,
      tx => this.knowledgeOperations().readResource(userId, { kind: 'mutation_receipt', args }, tx),
      result => this.drainStrictResponse(res, () => res.status(200).json(R(200, '操作成功', result)))));
  }

  private knowledgeOperations(): KnowledgeOperationsService {
    if (!this.operations) throw new ServiceUnavailableException('Knowledge operations unavailable');
    return this.operations;
  }

  private resourceArgs(tool: string, input: Record<string, any>): Record<string, any> {
    const args = { ...input };
    for (const key of ['limit', 'offset']) if (typeof args[key] === 'string' && /^\d+$/.test(args[key])) args[key] = Number(args[key]);
    validateKnowledgeToolArguments(tool, args);
    return args;
  }

  private readKnowledge(req: any, res: Response, kind: KnowledgeResource['kind'], tool: string, input: Record<string, any>) {
    const args = this.resourceArgs(tool, input);
    return this.resourceResponse(req.user.id, res, tx => this.knowledgeOperations().readResource(req.user.id, { kind, args }, tx));
  }

  @Get('v1/documents')
  @UseGuards(OpenApiGuard)
  listDocuments(@Req() req: any, @Res() res: Response, @Query() query: Record<string, any>) {
    return this.readKnowledge(req, res, 'documents', 'list_documents', query);
  }

  @Get('v1/documents/:docId/versions')
  @UseGuards(OpenApiGuard)
  listDocumentVersions(@Req() req: any, @Res() res: Response, @Param('docId') docId: string, @Query() query: Record<string, any>) {
    return this.readKnowledge(req, res, 'versions', 'list_document_versions', { ...query, doc_id: docId });
  }

  @Get('v1/documents/:docId')
  @UseGuards(OpenApiGuard)
  readDocument(@Req() req: any, @Res() res: Response, @Param('docId') docId: string, @Query() query: Record<string, any>) {
    return this.readKnowledge(req, res, 'document', 'read_document', { ...query, doc_id: docId });
  }

  @Get('v1/conversations')
  @UseGuards(OpenApiGuard)
  listConversations(@Req() req: any, @Res() res: Response, @Query() query: Record<string, any>) {
    return this.readKnowledge(req, res, 'conversations', 'list_conversations', query);
  }

  @Get('v1/conversations/:conversationId')
  @UseGuards(OpenApiGuard)
  getConversation(@Req() req: any, @Res() res: Response, @Param('conversationId') conversationId: string, @Query() query: Record<string, any>) {
    return this.readKnowledge(req, res, 'conversation', 'get_conversation', { ...query, conversation_id: conversationId });
  }

  @Post('v1/documents/text')
  @HttpCode(200)
  @UseGuards(OpenApiGuard)
  async ingestDocumentText(@Req() req: any, @Body() body: Record<string, any>, @Res() res: Response) {
    validateKnowledgeToolArguments('ingest_document_text', body);
    this.requireStrictAuthorization();
    const lifecycle = this.knowledgeOperations().lifecycle;
    if (!lifecycle) throw new ServiceUnavailableException('Document lifecycle unavailable');
    const result = await lifecycle.addTextDocument(req.user.id, body.kb_id,
      { title: body.title, content: body.content, duplicateMode: body.duplicateMode });
    return this.resourceResponse(req.user.id, res, tx => this.knowledgeOperations().readResource(req.user.id,
      { kind: 'mutation_receipt', args: { action: 'ingest_document_text', kb_id: body.kb_id, doc_id: result.documents[0].id } }, tx));
  }

  @Post('v1/documents/:docId/retry')
  @HttpCode(200)
  @UseGuards(OpenApiGuard)
  async retryDocument(@Req() req: any, @Param('docId') docId: string, @Body() body: Record<string, any>, @Res() res: Response) {
    const args: Record<string, any> = { ...body, doc_id: docId };
    validateKnowledgeToolArguments('retry_document', args);
    this.requireStrictAuthorization();
    const lifecycle = this.knowledgeOperations().lifecycle;
    if (!lifecycle) throw new ServiceUnavailableException('Document lifecycle unavailable');
    await lifecycle.retryDocument(req.user.id, args.kb_id, args.doc_id);
    return this.resourceResponse(req.user.id, res, tx => this.knowledgeOperations().readResource(req.user.id,
      { kind: 'mutation_receipt', args: { action: 'retry_document', ...args } }, tx));
  }

  @Delete('v1/documents/:docId')
  @UseGuards(OpenApiGuard)
  async deleteDocument(@Req() req: any, @Param('docId') docId: string, @Query() query: Record<string, any>, @Res() res: Response) {
    const args: Record<string, any> = { ...query, doc_id: docId };
    validateKnowledgeToolArguments('delete_document', args);
    this.requireStrictAuthorization();
    const lifecycle = this.knowledgeOperations().lifecycle;
    if (!lifecycle) throw new ServiceUnavailableException('Document lifecycle unavailable');
    await lifecycle.deleteDocument(req.user.id, args.kb_id, args.doc_id);
    return this.resourceResponse(req.user.id, res, tx => this.knowledgeOperations().readResource(req.user.id,
      { kind: 'mutation_receipt', args: { action: 'delete_document', ...args } }, tx));
  }
}
