import { ExternalChatEventReducer } from './external-chat-events';

describe('External chat event terminal contract', () => {
  it('replaces the draft and preserves the exact manifest without exporting it', () => {
    const reducer = new ExternalChatEventReducer();
    const manifest = [{ documentId: 'source', number: 1, versionId: 'v1', sourceHash: 'hash' }];
    reducer.consume({ data: { type: 'delta', content: 'unsupported draft' } });
    expect(reducer.consume({ data: { type: 'replace', content: 'verified answer' } })).toEqual({ type: 'replace', content: 'verified answer' });
    reducer.consume({ type: 'citation', index: 1, timeline_entry: { document_id: 'source', doc_title: 'Title' } });
    expect(reducer.consume({ type: 'done', dependency_manifest: manifest })).toBeNull();
    reducer.assertSuccessful();
    expect(reducer.answer).toBe('verified answer');
    expect(reducer.dependencyManifest).toBe(manifest);
    expect(reducer.citationEnvelopes[0].timeline_entry.document_id).toBe('source');
  });

  it('clears partial source data on a data error and prevents later successful completion', () => {
    const reducer = new ExternalChatEventReducer();
    reducer.consume({ type: 'delta', content: 'private partial answer' });
    reducer.consume({ type: 'citation', timeline_entry: { snippet: 'private evidence' } });
    reducer.consume({ type: 'trace', node: { id: 'retrieval', summary: 'private evidence' } });
    const frame = reducer.consume({ type: 'error', content: 'raw provider credential failure' });
    reducer.consume({ type: 'done', dependency_manifest: [{ documentId: 'source' }] });
    expect(() => reducer.assertSuccessful()).toThrow();
    expect(reducer.answer).toBe('');
    expect(reducer.citations).toEqual([]);
    expect(reducer.traceNodes.size).toBe(0);
    expect(JSON.stringify(frame)).not.toContain('credential');
    expect(reducer.dependencyManifest).toEqual({ kind: 'non_evidence', version: 1, outcome: 'failure' });
  });

  it('only marks an explicit refusal without citations as non-evidence', () => {
    const reducer = new ExternalChatEventReducer();
    reducer.consume({ type: 'delta', content: 'No supporting evidence.' });
    reducer.consume({ type: 'done', answer_kind: 'refusal' });
    expect(reducer.dependencyManifest).toEqual({ kind: 'non_evidence', version: 1, outcome: 'refusal' });
    const withEvidence = new ExternalChatEventReducer();
    withEvidence.consume({ type: 'citation', timeline_entry: { document_id: 'source' } });
    withEvidence.consume({ type: 'done', answer_kind: 'refusal' });
    expect(withEvidence.dependencyManifest).toBeUndefined();
  });

  it('rejects an unterminated draft and keeps the latest trace node per stage', () => {
    const reducer = new ExternalChatEventReducer();
    reducer.consume({ type: 'trace', node: { id: 'retrieval', status: 'running' } });
    reducer.consume({ type: 'trace', node: { id: 'retrieval', status: 'success' } });
    expect([...reducer.traceNodes.values()]).toEqual([{ id: 'retrieval', status: 'success' }]);
    reducer.consume({ type: 'delta', content: 'draft' });
    expect(() => reducer.assertSuccessful()).toThrow();
  });
});
