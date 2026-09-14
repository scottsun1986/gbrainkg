import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { getPrismaClient } from '../prisma';
import { extname, join } from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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
        name: 'search_knowledge',
        description:
          '在 GBrain 知识库中执行语义与混合检索（BAAI/bge-m3 密集向量 + BM25 全文 + 知识图谱联合召回），返回与查询语义匹配的高可信事实证据片段与引文来源。',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词、自然语言问题或待检索的语义陈述',
            },
            kb_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '限定检索的知识库 ID 列表（可选，默认检索当前凭证可见的所有知识库）',
            },
            top_k: {
              type: 'integer',
              description: '最大返回证据片段数，范围 1~50（默认 10）',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'chat_knowledge',
        description:
          '基于 GBrain 企业知识库进行智能问答与深度证据链推理（RAG），支持多跳推理、全证据链事实裁决与上下文多轮对话。',
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
              description: '限定检索的知识库 ID 列表（可选）',
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
          '获取向 GBrain 知识库直接上传本地大文件（PDF/Word/PPTX/Excel/Markdown/TXT等原始文件）的一键终端上传命令与操作指引。当用户询问如何上传文件、需要向知识库导入本地文档、或者想要上传大文件时，优先调用此工具引导用户或直接在后台执行上传。',
        inputSchema: {
          type: 'object',
          properties: {
            kb_id: {
              type: 'string',
              description:
                '目标知识库唯一 ID (UUID)。若用户未指定可留空，系统将自动列出所有可用知识库供选择。',
            },
            file_path: {
              type: 'string',
              description:
                '用户在对话中提及的本地文件路径或文件名（如 "/Users/username/report.pdf" 或 "D:\\docs\\方案.docx"），工具将自动拼装入终端上传命令中。',
            },
            title: {
              type: 'string',
              description: '文档标题（可选，默认使用文件名）',
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
        const query = String(args?.query || '').trim();
        if (!query) throw new Error('query 参数为必填项');
        const limit = Math.max(1, Math.min(Number(args?.top_k || 10) || 10, 50));
        const kbIds = Array.isArray(args?.kb_ids) ? args.kb_ids : undefined;

        const rawResults = await this.chatService.searchKnowledgeForAgent(
          userId,
          query,
          kbIds,
          limit,
        );

        const items = Array.isArray(rawResults?.results)
          ? rawResults.results
          : Array.isArray(rawResults)
            ? rawResults
            : [];

        return {
          query,
          total: typeof rawResults?.total === 'number' ? rawResults.total : items.length,
          results: items.map((r: any) => ({
            title: r.title || r.documentTitle || '未知文档',
            snippet: r.snippet || r.content || '',
            score: r.score ?? r.similarity ?? null,
            document_id: r.documentId || r.document_id || null,
            kb_id: r.kbId || r.kb_id || null,
            metadata: r.metadata || {},
          })),
        };
      }

      case 'chat_knowledge': {
        const prompt = String(args?.prompt || '').trim();
        if (!prompt) throw new Error('prompt 参数为必填项');
        const kbIds = Array.isArray(args?.kb_ids) ? args.kb_ids : undefined;

        let conversationId = args?.conversation_id;
        if (conversationId) {
          const conv = await this.prisma.conversation.findFirst({
            where: { id: conversationId, userId },
          });
          if (!conv) {
            throw new Error(`指定的会话 ID ${conversationId} 不存在或无权访问`);
          }
        } else {
          const newConv = await this.prisma.conversation.create({
            data: {
              userId,
              title: prompt.slice(0, 80),
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

        const stream$ = await this.chatService.handleChatStream(
          userId,
          prompt,
          kbIds,
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
            complete: () => {
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
        const rawFilePath = String(args?.file_path || '').trim();
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

        const sampleFilePath = rawFilePath || '@/path/to/your-file.pdf';
        const sampleFileArg = sampleFilePath.startsWith('@') ? sampleFilePath : `@${sampleFilePath}`;
        const kbIdArg = selectedKb ? selectedKb.id : 'TARGET_KB_ID';
        const titlePart = customTitle ? ` \\\n  -F "title=${customTitle}"` : '';

        const curlCmd = `curl -X POST "${uploadEndpoint}" \\
  -H "X-App-Id: ${effectiveAppId}" \\
  -H "X-App-Secret: YOUR_APP_SECRET" \\
  -F "file=${sampleFileArg}" \\
  -F "kb_id=${kbIdArg}"${titlePart}`;

        const psCmd = `$headers = @{ "X-App-Id" = "${effectiveAppId}"; "X-App-Secret" = "YOUR_APP_SECRET" }
$form = @{
    file = Get-Item "${rawFilePath || 'C:\\path\\to\\your-file.pdf'}"
    kb_id = "${kbIdArg}"
}
Invoke-RestMethod -Uri "${uploadEndpoint}" -Method Post -Headers $headers -Form $form`;

        const kbListText = kbs.length > 0
          ? kbs.map((k) => `  • 【${k.name}】 ID: ${k.id} (${k.type})`).join('\n')
          : '  （当前暂无可访问知识库，请先在系统内创建知识库）';

        const guideText = [
          `# 📄 GBrain 知识库文件直接上传指南 (免 Base64 / 原生支持最大 200MB)`,
          ``,
          `由于 MCP 协议基于纯文本传输，大文件（PDF/Word/PPTX/Excel 等）若强行转为 Base64 会极大消耗模型上下文 Token。`,
          `因此，GBrainKG 提供独立的高性能二进制直传通道：\`POST /mcp/upload\`。`,
          ``,
          `---`,
          `### 🤖 给 Agent（助手）的执行指示：`,
          `1. **如果您拥有系统终端（Terminal / Bash）执行权限**（如 Cursor Composer、Cline、本地开发助手等）：`,
          `   您可以直接在后台为用户执行下方的 \`curl\` 命令，完成本地文件秒级直传！`,
          `2. **如果您是纯文本聊天窗口**（如 Claude Desktop）：`,
          `   请将下方的上传命令与操作步骤清晰地展示给用户，引导用户在电脑终端中执行。`,
          `3. **上传完成后**：`,
          `   接口会返回 \`document_id\`。您可以随即调用 \`get_document_status(doc_id)\` 工具为用户追踪后台解析与知识图谱构建状态！`,
          ``,
          `---`,
          `### 🚀 一键上传命令 (Bash / macOS / Linux)：`,
          `\`\`\`bash`,
          curlCmd,
          `\`\`\``,
          ``,
          `### 🪟 Windows PowerShell 备选命令：`,
          `\`\`\`powershell`,
          psCmd,
          `\`\`\``,
          ``,
          selectedKb
            ? `> **当前目标知识库**：【${selectedKb.name}】(\`${selectedKb.id}\`)`
            : `> **当前可用知识库列表**（请将命令中的 \`TARGET_KB_ID\` 替换为您要上传的目标库 ID）：\n${kbListText}`,
          ``,
          `> 💡 **安全提示**：请将命令中的 \`YOUR_APP_SECRET\` 替换为您在系统【个人设置 -> API 凭证】中保存的实际密钥。`,
        ].join('\n');

        return {
          upload_endpoint: uploadEndpoint,
          app_id: effectiveAppId,
          target_kb: selectedKb ? { id: selectedKb.id, name: selectedKb.name } : null,
          available_knowledge_bases: kbs.map((k) => ({ id: k.id, name: k.name, type: k.type })),
          suggested_curl_command: curlCmd,
          guide: guideText,
        };
      }

      default: {
        throw new Error(`未知的工具名称: ${name}`);
      }
    }
  }
}
