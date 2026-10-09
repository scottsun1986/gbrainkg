import { BadRequestException } from '@nestjs/common';
import { parseAsOf } from '../retrieval/as-of';

const uuid = { type: 'string', format: 'uuid' };
const text = (maximum = 10000) => ({ type: 'string', minLength: 1, maxLength: maximum });
const scope = { oneOf: [{ type: 'array', items: uuid, minItems: 1, maxItems: 100 }, { type: 'string', enum: ['all'] }, uuid] };
const paging = { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 } };
const schema = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  ['chat_knowledge', '在当前权限及指定知识库范围问答；未指定范围时使用全部可见库。', schema({ prompt: text(), conversation_id: uuid, kb_ids: scope, asOf: { type: 'string', format: 'date-time' } }, ['prompt']), false],
  ['retrieve', '独立只读检索，返回出处、文档/版本与证据，不生成回答。', schema({ query: text(), kb_ids: scope, top_k: { type: 'integer', minimum: 1, maximum: 50 }, asOf: { type: 'string', format: 'date-time' } }, ['query']), true],
  ['aggregate_knowledge_table', '读取当前发布版本的完整表格清单或精确聚合。', schema({ documentId: uuid, versionId: uuid, tableId: text(200), operation: { type: 'string', enum: ['count', 'sum', 'min', 'max', 'avg'] }, column: { type: 'integer', minimum: 0, maximum: 100000 }, filters: { type: 'array', maxItems: 20, items: schema({ column: { type: 'integer', minimum: 0 }, operator: { type: 'string', enum: ['eq','ne','gt','gte','lt','lte','contains'] }, value: { type: ['string','number','boolean'] } }, ['column','operator','value']) }, includeSummary: { type: 'boolean' } }, ['documentId', 'versionId']), true],
  ['list_knowledge_bases', '分页列出可见知识库及可读发布文档数量。', schema({ ...paging, type: { type: 'string', enum: ['personal', 'org', 'industry', 'all'] } }), true],
  ['get_document_status', '读取可访问文档的解析、质量与版本定位。', schema({ doc_id: uuid }, ['doc_id']), true],
  ['get_user_info', '读取当前认证用户身份。', schema({}), true],
  ['get_file_upload_guide', '获取当前实例的multipart二进制上传指引；不支持Base64。', schema({ kb_id: uuid, title: text(200) }), true],
  ['list_documents', '在文档ACL/时效范围内分页读取清单。', schema({ kb_id: uuid, ...paging, search: text(200), status: { type: 'string', enum: ['published', 'parsing', 'parsed', 'indexing', 'failed', 'needs_review'] } }, ['kb_id']), true],
  ['read_document', '分页读取当前发布原文与active_version_id；offset为Unicode字符偏移。', schema({ doc_id: uuid, version_id: uuid, limit: { type: 'integer', minimum: 1, maximum: 64000 }, offset: { type: 'integer', minimum: 0, maximum: 100000000 } }, ['doc_id']), true],
  ['list_document_versions', '分页读取可访问文档已发布版本元数据，定位当前活动版本。', schema({ doc_id: uuid, ...paging }, ['doc_id']), true],
  ['ingest_document_text', '将原生文本写入可管理知识库并排队解析；不是Base64文件上传。', schema({ kb_id: uuid, title: text(200), content: text(10 * 1024 * 1024), duplicateMode: { type: 'string', enum: ['skip', 'copy'] } }, ['kb_id', 'content']), false],
  ['retry_document', '重试失败、待复核或过期解析；保留不可变发布版本。', schema({ kb_id: uuid, doc_id: uuid }, ['kb_id', 'doc_id']), false],
  ['delete_document', '删除可管理文档并清理检索、图谱、摘要及存储产物。', schema({ kb_id: uuid, doc_id: uuid }, ['kb_id', 'doc_id']), false],
  ['list_conversations', '分页列出当前用户自己的会话。', schema({ limit: paging.limit, before: uuid }), true],
  ['get_conversation', '分页读取自己会话，逐条复验助手回答的来源权限。', schema({ conversation_id: uuid, limit: paging.limit, before: uuid }, ['conversation_id']), true],
] as const;

export function getKnowledgeToolDefinitions(): any[] {
  return definitions.map(([name, description, inputSchema, readOnly]) => ({ name, description, inputSchema: JSON.parse(JSON.stringify(inputSchema)),
    annotations: { readOnlyHint: readOnly, destructiveHint: name === 'delete_document', openWorldHint: false } }));
}

export function validateKnowledgeToolArguments(name: string, args: unknown): asserts args is Record<string, any> {
  const definition = definitions.find(row => row[0] === name);
  const legacy = name === 'search_knowledge';
  if (!definition && !legacy) throw new BadRequestException('Unknown tool');
  const inputSchema: any = legacy ? schema({ query: text(), prompt: text(), kb_ids: scope,
    conversation_id: uuid, asOf: { type: 'string', format: 'date-time' }, top_k: { type: 'integer', minimum: 1, maximum: 50 } }) : definition![2];
  validate(args, inputSchema, 'arguments');
  if (legacy && !(args as any).query && !(args as any).prompt) throw new BadRequestException('query or prompt is required');
}

function validate(value: unknown, rule: any, path: string): void {
  const reject = () => { throw new BadRequestException(`Invalid ${path}`); };
  if (rule.oneOf) {
    for (const choice of rule.oneOf) { try { validate(value, choice, path); return; } catch {} }
    return reject();
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
    for (const key of rule.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) return reject();
    for (const [key, item] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(rule.properties, key)) return reject();
      validate(item, rule.properties[key], `${path}.${key}`);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems || 0) || value.length > rule.maxItems) return reject();
    for (const item of value) validate(item, rule.items, path);
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength ?? Infinity)) return reject();
    if (rule.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return reject();
    if (rule.format === 'date-time') parseAsOf(value);
  } else if (rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < rule.minimum || value > rule.maximum) return reject();
  }
  if (rule.enum && !rule.enum.includes(value)) return reject();
}
