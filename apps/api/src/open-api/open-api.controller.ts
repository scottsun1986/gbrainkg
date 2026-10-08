import { withAuthorizedRequest, authorizationEnforced } from '../permission/authorization-revision';
import { withStrictOutputPermit } from '../permission/strict-output-permit';
import { getRequestContext } from '../observability/request-context';
import { withServiceContext } from '../db/tenant-context.service';
import { DocumentAclService } from '../permission/document-acl.service';
import { uploadRoot } from '../storage/upload-paths';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
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
  ) {}

  /**
   * 1. 规范元数据接口：返回符合 OpenAPI 3.0.3 的接口定义规范 JSON
   */
  @Get('spec.json')
  getOpenApiSpec(@Req() req: any) {
    const host = req.get('host') || process.env.PUBLIC_BASE_URL || '';
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

    const items = Array.isArray(rawResults?.results)
      ? rawResults.results
      : Array.isArray(rawResults)
        ? rawResults
        : [];
    const total = typeof rawResults?.total === 'number' ? rawResults.total : items.length;

    return R(200, '操作成功', {
      query,
      total,
      results: items,
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
    },
  ) {
    const userId = req.user.id;
    if (process.env.KNOWLEDGE_STRICT_OUTPUT === "1" && !authorizationEnforced()) throw new BadRequestException("Strict output requires authorization enforcement");
    return withAuthorizedRequest(userId, async snapshot => {
    const outputContext = getRequestContext();
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json(R(400, 'prompt 不能为空'));
    }
    if (prompt.length > 10000) {
      return res.status(400).json(R(400, 'prompt 长度不能超过 10000 字符'));
    }

    const rawKbIds = Array.isArray(body.kb_ids)
      ? body.kb_ids.map((id: any) => String(id).trim()).filter(Boolean)
      : typeof body.kb_ids === 'string' && body.kb_ids.trim() && body.kb_ids !== 'all'
        ? [body.kb_ids.trim()]
        : [];
    const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);

    let conversation: any = null;
    let effectiveKbIds: string[];

    if (body.conversation_id) {
      conversation = await this.prisma.conversation.findFirst({
        where: { id: body.conversation_id, userId },
      });
      if (!conversation) {
        return res.status(404).json(R(404, '指定的 conversation_id 不存在或无权访问'));
      }
      if (rawKbIds.length > 0) {
        const unauthorized = rawKbIds.filter((id: string) => !visibleKbs.includes(id));
        if (unauthorized.length > 0) {
          return res.status(403).json(R(403, `无权访问知识库: ${unauthorized.join(', ')}`));
        }
        effectiveKbIds = rawKbIds;
      } else if (Array.isArray(conversation.kbScope) && (conversation.kbScope as string[]).length > 0) {
        effectiveKbIds = (conversation.kbScope as string[]).filter((id: string) => visibleKbs.includes(id));
      } else {
        effectiveKbIds = visibleKbs;
      }
    } else {
      effectiveKbIds = rawKbIds.length > 0
        ? rawKbIds.filter((id: string) => visibleKbs.includes(id))
        : visibleKbs;
    }

    conversation = await withServiceContext(this.prisma, async tx => {
      const target = conversation || await tx.conversation.create({
        data: { userId, title: prompt.slice(0, 80), kbScope: effectiveKbIds },
      });
      await tx.message.create({ data: { conversationId: target.id, role: 'user', content: prompt } });
      return target;
    });

    const wantsStream =
      Boolean(body.stream) ||
      String(req.headers.accept || '').includes('text/event-stream');

    const requestStartedAt = Date.now();
    const stream$ = await this.chatService.handleChatStream(
      userId,
      prompt,
      effectiveKbIds,
      conversation.id,
    );

    if (process.env.KNOWLEDGE_STRICT_OUTPUT === '1') {
      const frames: string[] = [];
      let bytes = 0;
      let answer = '';
      let citations: any[] = [];
      // Persist the REST envelope shape (`{ topic_slug, timeline_entry }`) so the
      // web mapper can resolve doc_title/document_id when the conversation is
      // reloaded; the bare timeline entry is only the transport payload.
      const citationEnvelopes: any[] = [];
      let manifest: unknown = undefined;
      await new Promise<void>((resolve, reject) => {
        let subscription: any;
        let stopped = false;
        const disconnected = () => { stopped = true; subscription?.unsubscribe(); reject(new Error('Transport disconnected')); };
        res.once('close', disconnected);
        subscription = stream$.subscribe({
          next: (event: any) => {
            if (stopped) return;
            const item = event?.data || event;
            if (item?.type === 'done') manifest = item.dependency_manifest;
            if (item?.type === 'delta' || item?.type === 'token') answer += item.content || item.token || '';
            if (item?.type === 'citations') { citations = item.citations || []; citationEnvelopes.length = 0; for (const c of citations) citationEnvelopes.push(c?.timeline_entry ? c : { type: 'citation', topic_slug: c?.topic_slug ?? c?.doc_title, timeline_entry: c }); }
            if (item?.type === 'citation') { citations.push(item.timeline_entry); citationEnvelopes.push({ type: 'citation', index: item.index, topic_slug: item.topic_slug ?? item.timeline_entry?.doc_title, timeline_entry: item.timeline_entry }); }
            const frame = `data: ${JSON.stringify(item)}\n\n`;
            bytes += Buffer.byteLength(frame);
            if (bytes > 8 * 1024 * 1024) {
              stopped = true;
              subscription?.unsubscribe();
              res.off('close', disconnected);
              reject(new BadRequestException('OpenAPI output buffer capacity exceeded'));
              return;
            }
            frames.push(frame);
          },
          error: (error: Error) => { res.off('close', disconnected); reject(error); },
          complete: () => { res.off('close', disconnected); resolve(); },
        });
        if (stopped) subscription.unsubscribe();
      });
      manifest ??= outputContext?.evidenceDependencies;
      await withStrictOutputPermit(userId, snapshot, async () => {
        await this.prisma.message.create({ data: { conversationId: conversation.id, role: 'assistant', content: answer,
          citationsSummary: citationEnvelopes, dependencyManifest: manifest as any, latencyMs: Date.now() - requestStartedAt } });
        if (wantsStream) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          await this.drainStrictResponse(res, () => res.end(frames.join('') + 'data: [DONE]\n\n'));
        } else {
          await this.drainStrictResponse(res, () => res.status(200).json(R(200, '操作成功', { conversation_id: conversation.id, answer, citations })));
        }
      }, manifest);
      return;
    }

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      let accumulated = '';
      const sub = stream$.subscribe({
        next: (event: any) => {
          const item = event?.data || event;
          if (item?.type === 'delta' || item?.type === 'token') {
            const chunk = item.content || item.token || '';
            accumulated += chunk;
            res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk })}\n\n`);
          } else if (item?.type === 'citation') {
            res.write(`data: ${JSON.stringify({ type: 'citation', citation: item.timeline_entry })}\n\n`);
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
              error: '问答服务暂时不可用，请重试',
            })}\n\n`,
          );
          res.end();
        },
        complete: async () => {
          try {
            const finalContent = accumulated || '本次问答未生成可保存的回答。';
            await this.prisma.message.create({
              data: {
                conversationId: conversation.id,
                role: 'assistant',
                content: finalContent,
                latencyMs: Date.now() - requestStartedAt,
              },
            });
          } catch (persistErr: any) {
            this.logger.error(`Failed to persist assistant message in open-api stream: ${persistErr?.message || persistErr}`);
          }
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
      const citationEnvelopes: any[] = [];
      let processingTrace: any = null;

      stream$.subscribe({
        next: (event: any) => {
          const item = event?.data || event;
          if (item?.type === 'delta' || item?.type === 'token') {
            accumulatedAnswer += item.content || item.token || '';
          } else if (item?.type === 'citation') {
            citations.push(item.timeline_entry);
            citationEnvelopes.push({ type: 'citation', index: item.index, topic_slug: item.topic_slug ?? item.timeline_entry?.doc_title, timeline_entry: item.timeline_entry });
          } else if (item?.type === 'citations') {
            citations = item.citations || [];
            citationEnvelopes.length = 0;
            for (const c of citations) citationEnvelopes.push(c?.timeline_entry ? c : { type: 'citation', topic_slug: c?.topic_slug ?? c?.doc_title, timeline_entry: c });
          } else if (item?.type === 'trace') {
            processingTrace = item.node || null;
          }
        },
        error: (err: any) => {
          res.status(500).json(R(500, '生成回答失败'));
          resolve();
        },
        complete: async () => {
          try {
            const finalContent = accumulatedAnswer || '本次问答未生成可保存的回答。';
            await this.prisma.message.create({
              data: {
                conversationId: conversation.id,
                role: 'assistant',
                content: finalContent,
                citationsSummary: citationEnvelopes,
                processingTrace: processingTrace ? [processingTrace] : undefined,
                latencyMs: Date.now() - requestStartedAt,
              },
            });
          } catch (persistErr: any) {
            this.logger.error(`Failed to persist assistant message in open-api: ${persistErr?.message || persistErr}`);
          }
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

      return R(200, `压缩包上传成功，已解压并提交 ${createdDocs.length} 篇文档至解析流水线`, {
        document_id: createdDocs[0]?.id,
        documents: createdDocs.map((d) => ({
          document_id: d.id,
          title: d.title,
          status: d.status,
          kb_id: d.kbId,
        })),
        total: createdDocs.length,
        kb_id: kbId,
      });
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
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const doc = await this.prisma.document.findFirst({
      where: { id: docId, kbId: { in: visibleIds } },
      include: { kb: { select: { id: true, name: true } } },
    });
    if (!doc || !await new DocumentAclService(this.permissionService).isDocumentReadable(userId, docId)) throw new NotFoundException('文档不存在');



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
