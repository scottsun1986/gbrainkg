import { getKnowledgeToolDefinitions } from '../mcp/knowledge-tool-schema';

export function completeOpenApiSpec(spec: any): any {
  const uuid = { type: 'string', format: 'uuid' };
  const scope = { oneOf: [{ type: 'array', minItems: 1, maxItems: 100, items: uuid }, uuid, { type: 'string', enum: ['all'] }],
    description: 'Omitted/all selects visible libraries; an explicit empty scope is invalid.' };
  const schemas = spec.components.schemas;
  schemas.R.required = ['code', 'msg', 'data'];
  schemas.HttpError = { oneOf: [{ $ref: '#/components/schemas/R' }, {
    type: 'object', required: ['statusCode', 'message'], properties: {
      statusCode: { type: 'integer' }, message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, error: { type: 'string' },
    },
  }] };
  const definitions = new Map(getKnowledgeToolDefinitions().map(tool => [tool.name, tool]));
  schemas.ChatCompletionRequest = JSON.parse(JSON.stringify(definitions.get('chat_knowledge').inputSchema));
  schemas.ChatCompletionRequest.properties.stream = { type: 'boolean', default: false };
  schemas.SearchRequest = JSON.parse(JSON.stringify(definitions.get('retrieve').inputSchema));
  schemas.ChatCompletionRequest.properties.prompt = { type: 'string', minLength: 1, maxLength: 10000 };
  schemas.ChatCompletionRequest.properties.conversation_id = uuid;
  schemas.ChatCompletionRequest.properties.kb_ids = scope;
  schemas.SearchRequest.properties.kb_ids = scope;
  schemas.SearchRequest.properties.query = { type: 'string', minLength: 1, maxLength: 10000 };
  schemas.SearchRequest.properties.top_k = { type: 'integer', minimum: 1, maximum: 50, default: 10 };
  schemas.KnowledgeBase = { type: 'object', required: ['id', 'name', 'type', 'document_count'], properties: {
    id: uuid, name: { type: 'string' }, type: { type: 'string', enum: ['personal', 'org', 'industry'] },
    description: { type: 'string', nullable: true }, document_count: { type: 'integer', minimum: 0, description: 'Readable, published, currently effective documents only.' },
    created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
  } };
  schemas.SearchHit = { type: 'object', required: ['documentId', 'kbId', 'title', 'evidence'], properties: {
    documentId: { ...uuid, nullable: true }, kbId: { ...uuid, nullable: true }, title: { type: 'string' },
    version: { type: 'integer' }, pageNo: { type: 'integer' }, articleNo: { type: 'string' },
    evidence: { type: 'string' }, score: { type: 'number' }, previewUrl: { type: 'string', nullable: true },
  } };
  schemas.SearchResult = { type: 'object', required: ['query', 'total', 'results'], properties: {
    query: { type: 'string' }, total: { type: 'integer' }, results: { type: 'array', items: { $ref: '#/components/schemas/SearchHit' } },
    exhaustive: { type: 'boolean', description: 'False means retrieval found no evidence; it is not proof the corpus contains none.' },
  } };
  schemas.ChatResult = { type: 'object', required: ['conversation_id', 'answer', 'citations'], properties: {
    conversation_id: uuid, answer: { type: 'string' }, citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    processing_trace: { type: 'array', items: { type: 'object', additionalProperties: true } },
  } };
  schemas.UploadResult = { type: 'object', required: ['kb_id'], properties: {
    kb_id: uuid, document_id: uuid, title: { type: 'string' }, status: { type: 'string', enum: ['parsing'] }, total: { type: 'integer' },
    documents: { type: 'array', items: { type: 'object', required: ['document_id', 'title', 'status', 'kb_id'], properties: {
      document_id: uuid, kb_id: uuid, title: { type: 'string' }, status: { type: 'string' },
    } } },
  } };
  schemas.DocumentStatus = { type: 'object', required: ['id', 'title', 'status', 'kb'], properties: {
    id: uuid, title: { type: 'string' }, status: { type: 'string' }, quality_status: { type: 'string', nullable: true },
    parser_engine: { type: 'string', nullable: true }, quality_issues: { nullable: true },
    kb: { type: 'object', properties: { id: uuid, name: { type: 'string' } } },
    created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
  } };
  schemas.DocumentMetadata = { type: 'object', required: ['id', 'kbId', 'title', 'status'], properties: {
    id: uuid, kbId: uuid, title: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' },
    activeVersionId: { ...uuid, nullable: true }, contentHash: { type: 'string', nullable: true }, indexReadiness: { type: 'string' },
    parserEngine: { type: 'string', nullable: true }, qualityStatus: { type: 'string' }, qualityIssues: {}, qualityScore: { type: 'number', nullable: true },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  } };
  schemas.PagedDocuments = { type: 'object', required: ['items', 'total', 'limit', 'offset'], properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/DocumentMetadata' } }, total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' },
  } };
  schemas.DocumentRead = { type: 'object', required: ['document', 'markdown_content', 'source_hash', 'active_version_id'], properties: {
    document: { $ref: '#/components/schemas/DocumentMetadata' }, active_version_id: { ...uuid, nullable: true }, source_hash: { type: 'string', nullable: true },
    markdown_content: { type: 'string' }, total_chars: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, next_offset: { type: 'integer', nullable: true },
    content_format: { type: 'string', enum: ['published_raw_blocks', 'legacy_markdown'] }, offset_unit: { type: 'string', enum: ['unicode_character'] }, manifest_hash: { type: 'string', nullable: true },
    source_refs: { type: 'array', items: { type: 'object', properties: { block_id: uuid, ord: { type: 'integer' }, char_start: { type: 'integer' }, char_end: { type: 'integer' } } } },
  } };
  schemas.DocumentVersions = { type: 'object', required: ['document_id', 'items', 'total'], properties: {
    document_id: uuid, active_version_id: { ...uuid, nullable: true }, legacy_version: { type: 'integer' }, total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' },
    items: { type: 'array', items: { type: 'object', properties: { id: uuid, number: { type: 'integer' }, state: { type: 'string', enum: ['published'] },
      title: { type: 'string' }, sourceHash: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, publishedAt: { type: 'string', format: 'date-time', nullable: true } } } },
  } };
  schemas.ConversationMetadata = { type: 'object', properties: { id: uuid, title: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } };
  schemas.ConversationList = { type: 'object', required: ['items', 'has_more', 'next_cursor'], properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/ConversationMetadata' } }, has_more: { type: 'boolean' }, next_cursor: { ...uuid, nullable: true },
  } };
  schemas.ConversationRead = { type: 'object', required: ['conversation', 'messages', 'has_more', 'next_cursor'], properties: {
    conversation: { $ref: '#/components/schemas/ConversationMetadata' }, has_more: { type: 'boolean' }, next_cursor: { ...uuid, nullable: true },
    messages: { type: 'array', items: { type: 'object', properties: { id: uuid, role: { type: 'string' }, content: { type: 'string' },
      citationsSummary: { type: 'array', nullable: true, items: { type: 'object' } }, createdAt: { type: 'string', format: 'date-time' } } } },
  } };
  schemas.MutationReceipt = { type: 'object', required: ['document_id', 'kb_id', 'status'], properties: {
    document_id: uuid, kb_id: uuid, status: { type: 'string', enum: ['accepted'] },
  } };
  schemas.UploadReceipt = { oneOf: [{ $ref: '#/components/schemas/MutationReceipt' }, {
    type: 'object', required: ['documents', 'total', 'status'], properties: {
      documents: { type: 'array', items: { $ref: '#/components/schemas/MutationReceipt' } }, total: { type: 'integer' }, status: { type: 'string', enum: ['accepted'] },
    },
  }] };
  const newRoutes: Array<[method: 'get' | 'post' | 'delete', path: string, tool: string, pathKey?: string]> = [
    ['get', '/open-api/v1/documents', 'list_documents', undefined],
    ['get', '/open-api/v1/documents/{docId}', 'read_document', 'doc_id'],
    ['get', '/open-api/v1/documents/{docId}/versions', 'list_document_versions', 'doc_id'],
    ['get', '/open-api/v1/conversations', 'list_conversations', undefined],
    ['get', '/open-api/v1/conversations/{conversationId}', 'get_conversation', 'conversation_id'],
    ['post', '/open-api/v1/documents/text', 'ingest_document_text', undefined],
    ['post', '/open-api/v1/documents/{docId}/retry', 'retry_document', 'doc_id'],
    ['delete', '/open-api/v1/documents/{docId}', 'delete_document', 'doc_id'],
  ];
  for (const [method, path, tool, pathKey] of newRoutes) {
    const definition = definitions.get(tool);
    const input = JSON.parse(JSON.stringify(definition.inputSchema));
    const operation: any = { summary: definition.description, responses: { 200: { description: 'Success', content: {
      'application/json': { schema: { $ref: '#/components/schemas/R' } },
    } } } };
    if (pathKey) {
      operation.parameters = [{ name: pathKey === 'doc_id' ? 'docId' : 'conversationId', in: 'path', required: true, schema: uuid }];
      delete input.properties[pathKey];
      input.required = input.required.filter((key: string) => key !== pathKey);
    }
    if (method === 'post') operation.requestBody = { required: true, content: { 'application/json': { schema: input } } };
    else operation.parameters = [...(operation.parameters ?? []), ...Object.entries<any>(input.properties).map(([name, rule]) => ({
      name, in: 'query', required: input.required.includes(name), schema: rule,
    }))];
    spec.paths[path] ??= {};
    spec.paths[path][method] = operation;
  }
  spec.paths['/open-api/v1/knowledge-bases'].get.parameters = Object.entries<any>(definitions.get('list_knowledge_bases').inputSchema.properties)
    .map(([name, schema]) => ({ name, in: 'query', schema }));
  spec.components.securitySchemes.BearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
  spec.security.push({ BearerAuth: [] });
  const resultTypes: Record<string, any> = {
    '/open-api/v1/knowledge-bases': { oneOf: [{ type: 'array', items: { $ref: '#/components/schemas/KnowledgeBase' } }, {
      type: 'object', description: 'Explicit limit/offset selects the paginated envelope.', required: ['total', 'knowledge_bases', 'limit', 'offset'],
      properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' },
        knowledge_bases: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeBase' } } },
    }] },
    '/open-api/v1/search': { $ref: '#/components/schemas/SearchResult' },
    '/open-api/v1/chat/completions': { $ref: '#/components/schemas/ChatResult' },
    '/open-api/v1/documents/upload': { oneOf: [{ $ref: '#/components/schemas/UploadResult' }, { $ref: '#/components/schemas/UploadReceipt' }],
      description: 'Strict output returns only fresh document identifiers and accepted receipts.' },
    '/open-api/v1/documents/status/{docId}': { $ref: '#/components/schemas/DocumentStatus' },
    '/open-api/v1/documents': { $ref: '#/components/schemas/PagedDocuments' },
    '/open-api/v1/documents/{docId}': { $ref: '#/components/schemas/DocumentRead' },
    '/open-api/v1/documents/{docId}/versions': { $ref: '#/components/schemas/DocumentVersions' },
    '/open-api/v1/conversations': { $ref: '#/components/schemas/ConversationList' },
    '/open-api/v1/conversations/{conversationId}': { $ref: '#/components/schemas/ConversationRead' },
  };
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const [method, operation] of Object.entries<any>(item)) {
      operation.operationId = method + path.replace(/[^a-zA-Z0-9]+/g, '_');
      for (const [code, description] of Object.entries({ 400: 'Invalid request', 401: 'Authentication required', 403: 'Forbidden or authorization changed', 404: 'Resource unavailable', 413: 'Request exceeds size budget', 429: 'Rate limit exceeded', 503: 'Service unavailable' })) {
        operation.responses[code] = { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpError' } } } };
      }
      if (resultTypes[path] && method !== 'delete') operation.responses['200'].content = { 'application/json': { schema: {
        allOf: [{ $ref: '#/components/schemas/R' }, { type: 'object', properties: { data: resultTypes[path] } }],
      } } };
      if (method === 'post' && (path.endsWith('/text') || path.endsWith('/retry')) || method === 'delete') {
        operation.responses['200'].content = { 'application/json': { schema: {
          allOf: [{ $ref: '#/components/schemas/R' }, { type: 'object', properties: { data: method === 'delete'
            ? { type: 'object', required: ['ok', 'documentId'], properties: { ok: { type: 'boolean' }, documentId: uuid } }
            : { $ref: '#/components/schemas/MutationReceipt' } } }],
        } } };
      }
    }
  }
  spec.paths['/open-api/v1/documents/upload'].post.requestBody = { required: true, content: { 'multipart/form-data': { schema: {
    type: 'object', required: ['file', 'kb_id'], properties: { file: { type: 'string', format: 'binary' }, kb_id: uuid },
  } } } };
  spec.paths['/open-api/v1/documents/status/{docId}'].get.parameters = [{ name: 'docId', in: 'path', required: true, schema: uuid }];
  spec.paths['/open-api/v1/chat/completions'].post.responses['200'].content['text/event-stream'] = {
    schema: { type: 'string' }, description: 'SSE data events: delta, replace, citation(s), trace; terminal done/[DONE], or error. Internal source manifests are never emitted.',
  };
  return spec;
}
