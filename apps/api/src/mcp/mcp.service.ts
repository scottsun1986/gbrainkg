import { Injectable, Logger } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { PermissionService } from '../permission/permission.service';
import { getPrismaClient } from '../prisma';

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

  constructor(
    private readonly chatService: ChatService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * 返回支持的 MCP 工具列表定义 (符合 MCP 2024-11-05 协议标准规范)
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
    ];
  }

  /**
   * 处理通用 MCP JSON-RPC 2.0 请求
   */
  async handleJsonRpc(user: any, request: any): Promise<any> {
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
          const toolResult = await this.executeTool(user, toolName, toolArgs);
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
   * 执行指定的 MCP 工具调用
   */
  async executeTool(user: any, name: string, args: Record<string, any>): Promise<any> {
    const userId = user?.id;
    if (!userId) {
      throw new Error('未获取到有效的用户上下文');
    }

    switch (name) {
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
                answer += item.content || item.token || '';
              } else if (item?.type === 'citation') {
                citations.push(item.timeline_entry);
              } else if (item?.type === 'citations') {
                if (Array.isArray(item.citations)) citations.push(...item.citations);
              } else if (item?.type === 'trace') {
                trace = item.node || null;
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

      default: {
        throw new Error(`未知的工具名称: ${name}`);
      }
    }
  }
}
