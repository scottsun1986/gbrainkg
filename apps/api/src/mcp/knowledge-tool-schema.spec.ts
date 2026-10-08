import { getKnowledgeToolDefinitions, validateKnowledgeToolArguments } from './knowledge-tool-schema';
const id = '11111111-1111-4111-8111-111111111111';
describe('knowledge tool contracts', () => {
  it('discovers every core operation and preserves the hidden QA alias', () => {
    const tools = getKnowledgeToolDefinitions();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['retrieve', 'list_documents', 'read_document',
      'list_document_versions', 'ingest_document_text', 'retry_document', 'delete_document', 'list_conversations', 'get_conversation']));
    expect(tools.map(t => t.name)).not.toContain('search_knowledge');
    expect(tools.find(t => t.name === 'delete_document').annotations.destructiveHint).toBe(true);
    validateKnowledgeToolArguments('search_knowledge', { query: 'question', kb_ids: id, top_k: 5 });
    validateKnowledgeToolArguments('chat_knowledge', { prompt: 'question', kb_ids: 'all' });
  });
  it.each([
    ['chat_knowledge', { prompt: 'question', kb_ids: [] }],
    ['chat_knowledge', { prompt: 'question', kb_ids: ['not-a-uuid'] }],
    ['chat_knowledge', { prompt: 'question', kb_ids: {} }],
    ['retrieve', { query: 'question', top_k: '5' }],
    ['retrieve', { query: 'question', top_k: 0 }],
    ['retrieve', { query: 'question', asOf: 'invalid' }],
    ['read_document', { doc_id: id, offset: -1 }],
    ['read_document', { doc_id: id, limit: 64001 }],
    ['list_documents', { kb_id: id, limit: 1.5 }],
    ['ingest_document_text', { kb_id: id, content: ' ' }],
    ['ingest_document_text', { kb_id: id, content: 'text', file_path: '/tmp/file' }],
    ['get_user_info', { constructor: 'ignored' }],
  ])('rejects %s invalid arguments', (name, args) => {
    expect(() => validateKnowledgeToolArguments(name as string, args)).toThrow();
  });
  it('does not allow callers to mutate the validation contract', () => {
    getKnowledgeToolDefinitions().find(t => t.name === 'retrieve').inputSchema.required.length = 0;
    expect(() => validateKnowledgeToolArguments('retrieve', {})).toThrow();
  });
});
