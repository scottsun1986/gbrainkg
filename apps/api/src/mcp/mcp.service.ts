import { getKnowledgeToolDefinitions, validateKnowledgeToolArguments } from './knowledge-tool-schema';
import { MCP_PROTOCOL_VERSIONS, trustedMcpInstanceUrl } from './mcp-protocol';
import { ExternalChatEventReducer } from '../chat/external-chat-events';
import { KnowledgeOperationsService, KnowledgeResource } from '../ingestion/knowledge-operations.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { captureEvidenceDependencies } from '../permission/evidence-dependencies';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '../ingestion/parser-capabilities';
import { uploadRoot } from '../storage/upload-paths';
import { parseAsOf } from '../retrieval/as-of';
import { getRequestContext } from '../observability/request-context';
import { TableEvidenceService } from '../retrieval/table-evidence.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { DocumentAclService } from '../permission/document-acl.service';
import { getPrismaClient } from '../prisma';
import { Prisma } from '@prisma/client';
import { extname, join } from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isArchiveFilename } from '../ingestion/parser-capabilities';
import { extractArchiveDocuments } from '../ingestion/archive-extractor';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

@Injectable()
export class McpService {
  private readonly resources = new WeakMap<object, KnowledgeResource>();
  private readonly logger = new Logger(McpService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    uploadRoot();

  constructor(
    private readonly chatService: ChatService,
    private readonly permissionService: PermissionService,
    @Optional() private readonly ingestionService?: IngestionService,
    @Optional() private readonly documentAclService?: DocumentAclService,
    @Optional() private readonly operations?: KnowledgeOperationsService,
  ) {}

  /**
   * 返回支持的 MCP 工具列表定义 (符合 MCP 2024-11-05 协议标准规范)
   * 注意：上传能力只保留 POST /mcp/upload 原始文件直传端点（multipart），
   * 不再提供 Base64 文本形式的 upload_document 工具。
   */
  getTools(): McpToolDefinition[] { return getKnowledgeToolDefinitions(); }

  getResultResource(result: object): KnowledgeResource | undefined { return this.resources.get(result); }
  async readResource(userId: string, resource: KnowledgeResource, db: any): Promise<any> {
    const operations = this.operations || new KnowledgeOperationsService(this.permissionService);
    const value = await operations.readResource(userId, resource, db);
    return resource.kind === 'upload_guide' ? this.uploadGuide(value, resource.args) : value;
  }

  private uploadGuide(inventory: any, args: any) {
    const auth = args.auth || {}; const selected = inventory.knowledge_bases.find((kb: any) => kb.id === args.kb_id);
    return { upload_endpoint: `${auth.instanceUrl || trustedMcpInstanceUrl()}/mcp/upload`, upload_method: 'POST multipart/form-data',
      auth: auth.method === 'app_credentials' ? { method: auth.method, app_id: auth.appId, headers: ['X-App-Id', 'X-App-Secret'] }
        : { method: 'bearer', headers: ['Authorization: Bearer <current token>'] },
      target_kb: selected || null, available_knowledge_bases: inventory.knowledge_bases,
      form_fields: { file: 'Original binary file; no Base64', kb_id: args.kb_id || 'Knowledge base UUID', title: args.title },
      guide: 'Upload the original file to this instance using the current authentication method. Base64 and server paths are unsupported.' };
  }

  /**
   * 处理通用 MCP JSON-RPC 2.0 请求（支持 Streamable HTTP 回调推送）
   */
  async handleJsonRpc(
    user: any,
    request: any,
    onProgress?: (event: any) => void,
  ): Promise<any> {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (request.id !== undefined && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id)))
      || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)))) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: payload must be an object' },
      };
    }

    const { id, method, params } = request;

    // Notification (no id, no reply required)
    if (id === undefined && typeof method === 'string') {
      this.logger.debug(`Received notification: ${method}`);
      return null;
    }

    try {
      switch (method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
              capabilities: {
                tools: { listChanged: false },

              },
              serverInfo: {
                name: 'gbrainkg-mcp',
                version: '1.0.0',
              },
            },
          };
        }

        case 'ping': {
          return {
            jsonrpc: '2.0',
            id,
            result: {},
          };
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: this.getTools(),
            },
          };
        }

        case 'tools/call': {
          if (typeof params?.name !== 'string') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool name required' } };
          const toolArgs = params.arguments ?? {};
          try { validateKnowledgeToolArguments(params.name, toolArgs); }
          catch { return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid tool arguments' } }; }
          const toolResult = await this.executeTool(user, params.name, toolArgs, onProgress);
          const response = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }], isError: false } };
          const resource = toolResult && typeof toolResult === 'object' ? this.resources.get(toolResult) : undefined;
          if (resource) this.resources.set(response, resource);
          return response;
        }

        case 'resources/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { resources: [] },
          };
        }

        case 'prompts/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { prompts: [] },
          };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
        }
      }
    } catch (err: any) {
      this.logger.error(`Error handling method ${method}: ${err?.message}`, err?.stack);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: [400, 403, 404].includes(err?.getStatus?.()) ? String(err.message) : 'Tool execution failed; retry or contact an administrator',
            },
          ],
          isError: true,
        },
      };
    }
  }

  /**
   * 共享上传管线：权限校验 → 落盘 → 建档 → 入队解析。
   * 由 POST /mcp/upload 文件直传端点（multipart/form-data，原始二进制）调用。
   */
  async saveUploadAndEnqueue(
    userId: string,
    input: { kbId: string; filename: string; fileBuffer: Buffer; title?: string },
  ) {
    const kbId = String(input.kbId || '').trim();
    validateKnowledgeToolArguments('get_file_upload_guide', { kb_id: kbId, ...(input.title === undefined ? {} : { title: input.title }) });
    const filename = String(input.filename || '').trim();
    if (!filename) throw new Error('filename 参数为必填项（文件名及扩展名）');
    const fileBuffer = input.fileBuffer;
    if (!fileBuffer || !fileBuffer.length) {
      throw new Error(`文件 ${filename} 的内容为空，请检查上传数据`);
    }
    const safeExt = extname(filename).toLowerCase();
    // The original file extension is the authoritative document format. An
    // optional caller-supplied title (e.g. "员工手册") must not drop it: the web
    // viewer derives the file type from the title and otherwise falls back to the
    // parsed markdown path (content.md), rendering an uploaded PDF as .md.
    const providedTitle = String(input.title || '').trim();
    const title = providedTitle
      ? (extname(providedTitle) ? providedTitle : `${providedTitle}${safeExt}`)
      : filename;

    if (!await this.permissionService.canManageKnowledgeBase(userId, kbId)) throw new ForbiddenException('Knowledge base unavailable');
    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, name: true, type: true, ownerUserId: true, status: true },
    });
    if (!kb || kb.status !== 'active') {
      throw new Error(`目标知识库不存在或已被禁用 (kb_id: ${kbId})`);
    }

    const canManage = await this.permissionService.canManageKnowledgeBase(userId, kbId);
    if (!canManage) {
      throw new ForbiddenException('Knowledge base unavailable');
    }

    if (!safeExt) {
      throw new Error(`文件名必须包含有效扩展名（如 .pdf, .docx, .md, .txt）`);
    }

    if (isArchiveFilename(filename)) {
      const extractedFiles = await extractArchiveDocuments(fileBuffer, filename);
      const createdDocs = [];
      for (const item of extractedFiles) {
        const childDocId = randomUUID();
        const itemExt = extname(item.filename).toLowerCase();
        if (!SUPPORTED_UPLOAD_EXTENSIONS.has(itemExt)) throw new Error("Unsupported archive entry type");
        const destDir = join(this.uploadRoot, childDocId);
        await fs.mkdir(destDir, { recursive: true });
        const localFilePath = join(destDir, `raw${itemExt}`);
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

        if (this.ingestionService) {
          await this.ingestionService.enqueue(
            childDoc.id,
            'upload',
            childDoc.version,
            item.size <= 1_000_000 ? 1 : 10,
          );
        }
        createdDocs.push(childDoc);
      }

      return {
        document_id: createdDocs[0]?.id,
        documents: createdDocs.map((d) => ({
          document_id: d.id,
          title: d.title,
          status: d.status,
        })),
        total: createdDocs.length,
        is_archive: true,
        filename,
        kb_id: kbId,
        kb_name: kb.name,
        size_bytes: fileBuffer.length,
        status: 'parsing',
        message: `压缩包 "${filename}" 已成功解压并提取 ${createdDocs.length} 篇文档提交至后台智能解析流水线。`,
      };
    }

    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(safeExt)) throw new Error("Unsupported file type");
    const documentId = randomUUID();
    const destDir = join(this.uploadRoot, documentId);
    await fs.mkdir(destDir, { recursive: true });
    const localFilePath = join(destDir, `raw${safeExt}`);
    await fs.writeFile(localFilePath, fileBuffer);

    const doc = await this.prisma.document.create({
      data: {
        id: documentId,
        kbId,
        mdPath: `${documentId}/content.md`,
        title,
        sourceType: 'upload',
        rawFileOid: localFilePath,
        version: 1,
        uploadedById: userId,
        status: 'parsing',
        qualityStatus: 'pending',
      },
    });

    if (this.ingestionService) {
      await this.ingestionService.enqueue(doc.id, 'upload', doc.version);
    }

    return {
      document_id: doc.id,
      title: doc.title,
      filename,
      kb_id: kbId,
      kb_name: kb.name,
      size_bytes: fileBuffer.length,
      status: 'parsing',
      message: `文档 "${doc.title}" 已成功上传至知识库 "${kb.name}"，并提交至后台智能解析流水线。可通过 get_document_status 工具追踪解析进度与切片质检。`,
    };
  }

  /**
   * 执行指定的 MCP 工具调用
   */
  async executeTool(
    user: any,
    name: string,
    args: Record<string, any>,
    onProgress?: (event: any) => void,
  ): Promise<any> {
    const userId = user?.id;
    if (!userId) {
      throw new Error('未获取到有效的用户上下文');
    }

    validateKnowledgeToolArguments(name, args);
    if (getRequestContext()) { getRequestContext()!.asOf = parseAsOf(args.asOf); getRequestContext()!.asOfExplicit = args.asOf != null; }
    switch (name) {
      // upload_document（Base64/文本上传）已按产品决策移除：
      // 上传能力统一走 POST /mcp/upload 原始文件直传端点。

      case 'aggregate_knowledge_table': {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuid.test(args?.documentId || '') || !uuid.test(args?.versionId || '')) throw new Error('documentId and versionId must be UUIDs');
        const result = await new TableEvidenceService().execute(user.id, args as any);
        const dependency_manifest = await captureEvidenceDependencies([{ docId: args.documentId, documentVersionId: args.versionId }]);
        return { ...result, dependency_manifest };
      }
      case 'search_knowledge': {
        // search_knowledge 工具已正式下线，统一收敛至端到端事实裁决工具 chat_knowledge。
        // 为向下兼容已建立连接的旧客户端调用，将 query/prompt 统一转发至 chat_knowledge。
        const prompt = String(args?.query || args?.prompt || '').trim();
        if (!prompt) throw new Error('query 或 prompt 参数为必填项');
        return this.executeTool(
          user,
          'chat_knowledge',
          {
            prompt,
            ...(args?.kb_ids !== undefined ? { kb_ids: args.kb_ids } : {}),
            ...(args?.conversation_id ? { conversation_id: args.conversation_id } : {}),
            ...(args?.asOf ? { asOf: args.asOf } : {}),
          },
          onProgress,
        );
      }

      case 'chat_knowledge': {
        if (getRequestContext()) { getRequestContext()!.asOf=parseAsOf(args?.asOf);getRequestContext()!.asOfExplicit=args?.asOf!=null; }
        const prompt = String(args?.prompt || '').trim();
        if (!prompt) throw new Error('prompt 参数为必填项');
        const rawKbIds = Array.isArray(args?.kb_ids)
          ? args.kb_ids.map((id: any) => String(id).trim()).filter(Boolean)
          : typeof args?.kb_ids === 'string' && args.kb_ids.trim() && args.kb_ids !== 'all'
            ? [args.kb_ids.trim()]
            : [];
        const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);

        if (rawKbIds.some((id: string) => !visibleKbs.includes(id))) throw new ForbiddenException('Requested knowledge base unavailable');
        let conversationId = args?.conversation_id;
        let effectiveKbIds: string[];

        if (conversationId) {
          const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, userId },
          });
          if (!conv) {
            throw new Error(`指定的会话 ID ${conversationId} 不存在或无权访问`);
          }
          if (rawKbIds.length > 0) {
            effectiveKbIds = rawKbIds.filter((id: string) => visibleKbs.includes(id));
          } else if (Array.isArray(conv.kbScope) && (conv.kbScope as string[]).length > 0) {
            effectiveKbIds = (conv.kbScope as string[]).filter((id: string) => visibleKbs.includes(id));
          } else {
            effectiveKbIds = visibleKbs;
          }
        } else {
          effectiveKbIds = rawKbIds.length > 0
            ? rawKbIds.filter((id: string) => visibleKbs.includes(id))
            : visibleKbs;
          if (!effectiveKbIds.length) throw new ForbiddenException('No visible knowledge bases');
          const newConv = await this.prisma.conversation.create({
            data: {
              userId,
              title: prompt.slice(0, 80),
              kbScope: effectiveKbIds,
            },
          });
          conversationId = newConv.id;
        }

        if (!effectiveKbIds.length) throw new ForbiddenException('No knowledge bases remain in the selected scope');
        await this.prisma.message.create({
          data: {
            conversationId,
            role: 'user',
            content: prompt,
          },
        });

        const startedAt = Date.now();
        const stream$ = await this.chatService.handleChatStream(
          userId,
          prompt,
          effectiveKbIds,
          conversationId,
        );

        return new Promise((resolve, reject) => {
          const state = new ExternalChatEventReducer();
          stream$.subscribe({
            next: event => {
              const frame = state.consume(event);
              if (!frame || !onProgress) return;
              if (frame.type === 'delta') onProgress({ type: 'token', delta: frame.content, conversation_id: conversationId });
              else onProgress(frame);
            },
            error: error => { state.fail(); reject(error); },
            complete: async () => {
              try {
                state.assertSuccessful();
                await this.prisma.message.create({ data: { conversationId, role: 'assistant', content: state.answer,
                  citationsSummary: state.citationEnvelopes, dependencyManifest: state.dependencyManifest as Prisma.InputJsonValue | undefined,
                  processingTrace: [...state.traceNodes.values()], latencyMs: Date.now() - startedAt } });
                resolve({ conversation_id: conversationId, answer: state.answer, citations: state.citations,
                  dependency_manifest: state.dependencyManifest, processing_trace: [...state.traceNodes.values()] });
              } catch (error) { reject(error); }
            },
          });
        });
      }

      case 'list_knowledge_bases': case 'get_document_status': case 'get_user_info': case 'get_file_upload_guide':
      case 'list_documents': case 'read_document': case 'list_document_versions': case 'list_conversations': case 'get_conversation': {
        const kinds: Record<string, KnowledgeResource['kind']> = { list_knowledge_bases: 'knowledge_bases', get_document_status: 'document_status',
          get_user_info: 'user_info', get_file_upload_guide: 'upload_guide', list_documents: 'documents', read_document: 'document',
          list_document_versions: 'versions', list_conversations: 'conversations', get_conversation: 'conversation' };
        const resource: KnowledgeResource = { kind: kinds[name], args: { ...args, ...(name === 'get_file_upload_guide' ? { auth: user.mcpAuth } : {}) } };
        const payload = await this.readResource(userId, resource, this.prisma);
        this.resources.set(payload, resource);
        return payload;
      }
      case 'retrieve': {
        const result = await this.chatService.searchKnowledgeForAgent(userId, args.query, args.kb_ids, args.top_k ?? 10);
        const payload = { ...result, dependency_manifest: result.dependencyManifest };
        if (!result.results?.length) this.resources.set(payload, { kind: 'retrieval_empty', args: { query: args.query,
          kb_ids: result.kbScope || (Array.isArray(args.kb_ids) ? args.kb_ids : await this.permissionService.getVisibleKnowledgeBases(userId)) } });
        return payload;
      }
      case 'ingest_document_text': case 'retry_document': case 'delete_document': {
        if (!this.operations?.lifecycle) throw new Error('Document lifecycle unavailable');
        const lifecycle = this.operations.lifecycle;
        const result = name === 'ingest_document_text' ? await lifecycle.addTextDocument(userId, args.kb_id, {
          title: args.title, content: args.content, duplicateMode: args.duplicateMode })
          : name === 'retry_document' ? await lifecycle.retryDocument(userId, args.kb_id, args.doc_id)
          : await lifecycle.deleteDocument(userId, args.kb_id, args.doc_id);
        const docId = 'documentId' in result ? result.documentId : 'document' in result ? result.document.id : result.documents?.[0]?.id;
        const resource: KnowledgeResource = { kind: 'mutation_receipt', args: { kb_id: args.kb_id, doc_id: docId, action: name } };
        const payload = await this.readResource(userId, resource, this.prisma);
        this.resources.set(payload, resource);
        return payload;
      }

      default: {
        throw new Error(`未知的工具名称: ${name}`);
      }
    }
  }
}
