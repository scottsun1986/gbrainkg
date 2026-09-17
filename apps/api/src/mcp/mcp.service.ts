import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { getPrismaClient } from '../prisma';
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
  private readonly logger = new Logger(McpService.name);
  private readonly prisma = getPrismaClient();
  private readonly uploadRoot =
    process.env.UPLOAD_ROOT || join(process.cwd(), 'runtime/uploads');

  constructor(
    private readonly chatService: ChatService,
    private readonly permissionService: PermissionService,
    @Optional() private readonly ingestionService?: IngestionService,
  ) {}

  /**
   * 返回支持的 MCP 工具列表定义 (符合 MCP 2024-11-05 协议标准规范)
   * 注意：上传能力只保留 POST /mcp/upload 原始文件直传端点（multipart），
   * 不再提供 Base64 文本形式的 upload_document 工具。
   */
  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'chat_knowledge',
        description:
          '基于 GBrain 企业知识库进行智能问答与深度证据链推理（RAG），支持多跳推理、全证据链事实裁决与上下文多轮对话。若用户未明确限定特定知识库，请勿指定 kb_ids，系统将默认在当前凭证有权限访问的全部知识库中联合检索。',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '提问内容或需要知识库解答的具体问题',
            },
            conversation_id: {
              type: 'string',
              description: '会话 ID（可选，传入可延续历史上下文）',
            },
            kb_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '限定检索的知识库 ID 列表（可选，若未明确指定或为空，系统默认在当前凭证可见的全部知识库中检索）',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'list_knowledge_bases',
        description:
          '获取当前凭证用户有权限访问的知识库列表（包括个人知识库、组织知识库与行业知识库）以及各库的文档统计信息。',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['personal', 'org', 'industry', 'all'],
              description: '知识库类型筛选（可选，默认 all）',
            },
          },
        },
      },
      {
        name: 'get_document_status',
        description:
          '查询指定文档的入库解析进度、状态、分块数量及质检指标。',
        inputSchema: {
          type: 'object',
          properties: {
            doc_id: {
              type: 'string',
              description: '待查询的文档唯一 ID (UUID)',
            },
          },
          required: ['doc_id'],
        },
      },
      {
        name: 'get_user_info',
        description:
          '查询当前 MCP 鉴权凭证 (AppId / AppSecret) 绑定的用户身份信息、所属组织及角色权限。',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_file_upload_guide',
        description:
          '获取向 GBrain 知识库上传本地文件的方法与规范指引。GBrain 不支持将文档转为 Base64 文本上传，必须通过独立二进制直传接口 POST /mcp/upload 提交。上传接口所需的 X-App-Id 与 X-App-Secret 与当前客户端连接此 MCP 服务时配置的凭证（AppId/AppKey/AppSecret）完全一致。AI 模型获取此指引后，应由 AI 自行根据用户的实际文件路径与目标知识库组装完整的上传命令或发起请求，无需用户自行拼装参数。',
        inputSchema: {
          type: 'object',
          properties: {
            kb_id: {
              type: 'string',
              description:
                '目标知识库唯一 ID (UUID)（可选，若用户未指定则返回所有可用知识库供选择）',
            },
            title: {
              type: 'string',
              description: '文档显示标题（可选，默认使用原始文件名）',
            },
          },
        },
      },
    ];
  }

  /**
   * 处理通用 MCP JSON-RPC 2.0 请求（支持 Streamable HTTP 回调推送）
   */
  async handleJsonRpc(
    user: any,
    request: any,
    onProgress?: (event: any) => void,
  ): Promise<any> {
    if (!request || typeof request !== 'object') {
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
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false },
                prompts: { listChanged: false },
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
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          const toolResult = await this.executeTool(user, toolName, toolArgs, onProgress);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2),
                },
              ],
              isError: false,
            },
          };
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
              text: `Tool execution failed: ${err?.message || 'Internal Server Error'}`,
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
    if (!kbId) throw new Error('kb_id 参数为必填项（目标知识库 ID）');
    const filename = String(input.filename || '').trim();
    if (!filename) throw new Error('filename 参数为必填项（文件名及扩展名）');
    const fileBuffer = input.fileBuffer;
    if (!fileBuffer || !fileBuffer.length) {
      throw new Error(`文件 ${filename} 的内容为空，请检查上传数据`);
    }
    const title = String(input.title || '').trim() || filename;

    const kb = await this.prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { id: true, name: true, type: true, ownerUserId: true, status: true },
    });
    if (!kb || kb.status !== 'active') {
      throw new Error(`目标知识库不存在或已被禁用 (kb_id: ${kbId})`);
    }

    const canManage = await this.permissionService.canManageKnowledgeBase(userId, kbId);
    if (!canManage) {
      throw new Error(`当前凭证对应的用户无权向知识库 "${kb.name}" (${kbId}) 上传或维护文档`);
    }

    const safeExt = extname(filename).toLowerCase();
    if (!safeExt) {
      throw new Error(`文件名必须包含有效扩展名（如 .pdf, .docx, .md, .txt）`);
    }

    if (isArchiveFilename(filename)) {
      const extractedFiles = await extractArchiveDocuments(fileBuffer, filename);
      const createdDocs = [];
      for (const item of extractedFiles) {
        const childDocId = randomUUID();
        const itemExt = extname(item.filename).toLowerCase();
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

    switch (name) {
      // upload_document（Base64/文本上传）已按产品决策移除：
      // 上传能力统一走 POST /mcp/upload 原始文件直传端点。

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
            kb_ids: args?.kb_ids,
            conversation_id: args?.conversation_id,
          },
          onProgress,
        );
      }

      case 'chat_knowledge': {
        const prompt = String(args?.prompt || '').trim();
        if (!prompt) throw new Error('prompt 参数为必填项');
        const rawKbIds = Array.isArray(args?.kb_ids)
          ? args.kb_ids.map((id: any) => String(id).trim()).filter(Boolean)
          : typeof args?.kb_ids === 'string' && args.kb_ids.trim() && args.kb_ids !== 'all'
            ? [args.kb_ids.trim()]
            : [];
        const visibleKbs = await this.permissionService.getVisibleKnowledgeBases(userId);

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
          const newConv = await this.prisma.conversation.create({
            data: {
              userId,
              title: prompt.slice(0, 80),
              kbScope: effectiveKbIds,
            },
          });
          conversationId = newConv.id;
        }

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
          let answer = '';
          const citations: any[] = [];
          let trace: any = null;

          stream$.subscribe({
            next: (event: any) => {
              const item = event?.data || event;
              if (item?.type === 'delta' || item?.type === 'token') {
                const chunk = item.content || item.token || '';
                answer += chunk;
                if (onProgress) {
                  onProgress({
                    type: 'token',
                    delta: chunk,
                    conversation_id: conversationId,
                  });
                }
              } else if (item?.type === 'citation') {
                citations.push(item.timeline_entry);
                if (onProgress) {
                  onProgress({
                    type: 'citation',
                    citation: item.timeline_entry,
                  });
                }
              } else if (item?.type === 'citations') {
                if (Array.isArray(item.citations)) {
                  citations.push(...item.citations);
                }
              } else if (item?.type === 'trace') {
                trace = item.node || null;
                if (onProgress) {
                  onProgress({
                    type: 'trace',
                    trace,
                  });
                }
              }
            },
            error: (err: any) => reject(new Error(err?.message || 'Chat generation error')),
            complete: async () => {
              try {
                const finalContent = answer || '本次问答未生成可保存的回答。';
                await this.prisma.message.create({
                  data: {
                    conversationId,
                    role: 'assistant',
                    content: finalContent,
                    citationsSummary: citations,
                    processingTrace: trace ? [trace] : undefined,
                    latencyMs: Date.now() - startedAt,
                  },
                });
              } catch (persistErr: any) {
                this.logger.error(
                  `Failed to persist assistant message in MCP chat_knowledge: ${persistErr?.message || persistErr}`,
                );
              }
              resolve({
                conversation_id: conversationId,
                answer,
                citations,
                processing_trace: trace,
              });
            },
          });
        });
      }

      case 'list_knowledge_bases': {
        const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
        const whereClause: any = { id: { in: visibleIds }, status: 'active' };
        if (args?.type && ['personal', 'org', 'industry'].includes(args.type)) {
          whereClause.type = args.type;
        }

        const kbs = await this.prisma.knowledgeBase.findMany({
          where: whereClause,
          include: { _count: { select: { documents: true } } },
          orderBy: { createdAt: 'desc' },
        });

        return {
          total: kbs.length,
          knowledge_bases: kbs.map((kb) => ({
            id: kb.id,
            name: kb.name,
            type: kb.type,
            description: kb.description,
            document_count: kb._count.documents,
            created_at: kb.createdAt,
            updated_at: kb.updatedAt,
          })),
        };
      }

      case 'get_document_status': {
        const docId = String(args?.doc_id || '').trim();
        if (!docId) throw new Error('doc_id 参数为必填项');

        const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
        const document = await this.prisma.document.findFirst({
          where: { id: docId, kbId: { in: visibleIds } },
          include: {
            kb: { select: { id: true, name: true, type: true } },
            _count: { select: { chunks: true } },
          },
        });

        if (!document) {
          throw new Error('未找到该文档或无权限查看');
        }

        return {
          id: document.id,
          title: document.title,
          status: document.status,
          source_type: document.sourceType,
          parser_engine: document.parserEngine,
          index_readiness: document.indexReadiness,
          chunk_count: document._count.chunks,
          quality_score: document.qualityScore,
          quality_status: document.qualityStatus,
          knowledge_base: {
            id: document.kb.id,
            name: document.kb.name,
            type: document.kb.type,
          },
          created_at: document.createdAt,
          updated_at: document.updatedAt,
        };
      }

      case 'get_user_info': {
        return {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          roles: user.roles?.map((r: any) => r.role?.name || r.roleName) || [],
          orgs: user.orgs?.map((o: any) => o.orgNode?.name || o.orgNodeId) || [],
        };
      }

      case 'get_file_upload_guide': {
        const targetKbId = String(args?.kb_id || '').trim();
        const customTitle = String(args?.title || '').trim();

        const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
        const kbs = await this.prisma.knowledgeBase.findMany({
          where: { id: { in: visibleIds }, status: 'active' },
          select: { id: true, name: true, type: true, description: true },
          orderBy: { createdAt: 'desc' },
        });

        let selectedKb = targetKbId ? kbs.find((k) => k.id === targetKbId) : undefined;
        if (!selectedKb && kbs.length === 1) {
          selectedKb = kbs[0];
        }

        const cred = await this.prisma.userCredential.findFirst({
          where: { userId, status: 'active' },
          select: { appId: true },
          orderBy: { createdAt: 'desc' },
        });
        const effectiveAppId = cred?.appId || (user as any)?.appId || 'YOUR_APP_ID';

        const baseUrl = (process.env.NEXT_PUBLIC_MCP_URL?.trim() || 'https://knowledge.5gsailor.com:20080').replace(/\/+$/, '');
        const uploadEndpoint = `${baseUrl}/mcp/upload`;

        const kbListText = kbs.length > 0
          ? kbs.map((k) => `  • 【${k.name}】 ID: \`${k.id}\` (${k.type})`).join('\n')
          : '  （当前暂无可访问知识库，请先在知识库页面创建知识库）';

        const guideText = [
          `# 📄 GBrain 知识库文件直接上传指南 (免 Base64 / 原生二进制上传)`,
          ``,
          `### ⚠️ 核心上传原则`,
          `1. **严禁使用 Base64 编码上传**：大文件转为 Base64 会极大消耗模型上下文且可能因截断损坏，系统不支持且已彻底关闭 Base64 文本上传。所有文档必须通过独立二进制直传端点进行上传（支持 PDF, DOCX, PPTX, XLSX, TXT, MD 等，最大 200MB）。`,
          `2. **鉴权凭证一致**：上传所需的 \`X-App-Id\` 和 \`X-App-Secret\` 与您在当前 MCP 客户端（如 Cursor / Claude Desktop / Cline 等）配置连接此 MCP 服务时所使用的凭证（AppId 和 AppKey）**完全一致**，无需单独申请新凭证。`,
          ``,
          `### 📡 上传接口与格式规范`,
          `- **请求端点**: \`POST ${uploadEndpoint}\``,
          `- **Content-Type**: \`multipart/form-data\``,
          `- **请求头 (Headers)**:`,
          `  - \`X-App-Id\`: \`${effectiveAppId}\``,
          `  - \`X-App-Secret\`: 与当前 MCP 客户端中配置的 AppSecret / AppKey 一致`,
          `- **表单字段 (Multipart Fields)**:`,
          `  - \`file\`: 待上传的本地文件原始二进制（必填，必须携带真实扩展名如 .pdf, .docx, .pptx 等）`,
          `  - \`kb_id\`: 目标知识库 ID（必填）`,
          `  - \`title\`: 文档显示标题（可选）`,
          ``,
          `### 🤖 给 AI 助手的指示（相关信息由 AI 自行组装）`,
          `- **无需用户手动拼装参数**：请由 AI 自动结合用户在对话中提及的本地文件路径与目标知识库，自行组装完整的上传命令（如 curl 或 Python 脚本）或发起 HTTP 请求。`,
          `- **凭据填充**：鉴权 AppId 与 AppKey/AppSecret 即为当前客户端配置 MCP 服务时使用的同一套凭据。`,
          `- **入库状态跟踪**：上传成功后接口将返回 \`document_id\`，AI 应随即调用 \`get_document_status(doc_id)\` 帮助用户跟踪后台分块解析与质检进度。`,
          ``,
          selectedKb
            ? `> **当前目标知识库**：【${selectedKb.name}】(\`${selectedKb.id}\`)`
            : `> **当前可用知识库列表**：\n${kbListText}`,
        ].join('\n');

        return {
          upload_method: 'POST multipart/form-data (仅支持二进制原始文件直传，严禁使用 Base64)',
          upload_endpoint: uploadEndpoint,
          auth: {
            header_app_id: 'X-App-Id',
            app_id: effectiveAppId,
            header_app_secret: 'X-App-Secret',
            note: '上传接口鉴权 Header (X-App-Id 与 X-App-Secret) 与当前 MCP 客户端配置完全一致',
          },
          target_kb: selectedKb ? { id: selectedKb.id, name: selectedKb.name } : null,
          available_knowledge_bases: kbs.map((k) => ({ id: k.id, name: k.name, type: k.type })),
          form_fields: {
            file: '本地文件原始二进制（必填，须包含真实文件扩展名）',
            kb_id: selectedKb ? selectedKb.id : '目标知识库 UUID（必填）',
            title: customTitle || '文档显示标题（可选）',
          },
          ai_assembly_instructions:
            '由 AI 自动根据用户的本地文件路径和目标知识库，组装上传请求或 curl 终端指令。AppId 与 AppSecret 与当前 MCP 配置一致。禁止转换 Base64。',
          guide: guideText,
        };
      }

      default: {
        throw new Error(`未知的工具名称: ${name}`);
      }
    }
  }
}
