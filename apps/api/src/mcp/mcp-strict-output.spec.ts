import { EventEmitter } from 'node:events';
import { McpController } from './mcp.controller';
import { runWithRequestContext,getRequestContext } from '../observability/request-context';
import { withStrictOutputPermit, withStrictResourceOutput } from '../permission/strict-output-permit';
const snapshot = { revision:'42',policyVersion:'core-auth-v1',expiresAt:Infinity };
jest.mock('../prisma', () => ({ getPrismaClient: () => ({}) }));
jest.mock('../permission/authorization-revision', () => ({
  authorizationEnforced: () => true,
  withAuthorizedRequest:(userId:string,work:any) => runWithRequestContext({ requestId:'mcp-test',userId },()=>work(snapshot)),
  assertAuthorizationSnapshot:jest.fn().mockResolvedValue(undefined),
  readAuthorizationSnapshot:jest.fn().mockImplementation(async () => ({ ...snapshot, revision: '43' })),
}));
jest.mock('../permission/strict-output-permit', () => ({ withStrictOutputPermit:jest.fn(), withStrictResourceOutput:jest.fn() }));

describe('strict MCP transports', () => {
  const previous = process.env.KNOWLEDGE_STRICT_OUTPUT;
  let controller: McpController;
  let approved: boolean;
  let service: any;
  beforeEach(() => {
    jest.clearAllMocks();process.env.KNOWLEDGE_STRICT_OUTPUT='1';approved=false;
    (withStrictOutputPermit as jest.Mock).mockImplementation(async (_user,_snapshot,emit) => { approved=true;await emit();approved=false; });
    (withStrictResourceOutput as jest.Mock).mockImplementation(async (_user,_snapshot,read,emit) => { approved=true;await emit(await read({}));approved=false; });
    service={ handleJsonRpc:jest.fn(async () => { expect(getRequestContext()?.userId).toBe('reader');return { jsonrpc:'2.0',id:1,result:{ content:[{ text:'authorized secret' }] } }; }) };
    controller=new McpController(service,{ verifyCredential:jest.fn().mockResolvedValue({ user:{ id:'reader' }, credential: { id:'cred' } }) } as any,{ check:()=>({ allowed:true }) } as any,{} as any);
  });
  afterEach(() => { controller.onModuleDestroy();if (previous===undefined) delete process.env.KNOWLEDGE_STRICT_OUTPUT;else process.env.KNOWLEDGE_STRICT_OUTPUT=previous; });
  function response() {
    const res:any=new EventEmitter();res.writableEnded=false;res.writableFinished=false;res.writableLength=0;
    res.setHeader=jest.fn();res.flushHeaders=jest.fn();res.status=jest.fn(()=>res);
    res.write=jest.fn((value:string) => { if(value.includes('authorized secret')) expect(approved).toBe(true);return true; });
    res.end=jest.fn(()=>{ res.writableEnded=true;res.writableFinished=true;res.emit('finish'); });
    res.json=jest.fn((value:any) => { expect(approved).toBe(true);res.end();return res; });
    return res;
  }
  const req:any={ headers:{ 'x-app-id':'id','x-app-secret':'secret' },query:{} };
  it('buffers stream results and sends them only inside a serialization permit', async () => {
    const res=response();await controller.handleStreamEndpoint(req,res,{ id:1,method:'tools/call',params:{ name:'search_knowledge' } });
    expect(service.handleJsonRpc.mock.calls[0][2]).toBeUndefined();
    expect(withStrictOutputPermit).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledTimes(1);
  });
  it('protects the JSON response with the same permit', async () => {
    const res=response();await controller.handleDirectRpc(req,res,{ id:1,method:'tools/call',params:{ name:'search_knowledge' } });
    expect(withStrictOutputPermit).toHaveBeenCalledTimes(1);expect(res.json).toHaveBeenCalledTimes(1);
  });
  it('never emits buffered evidence after permit rejection', async () => {
    (withStrictOutputPermit as jest.Mock).mockRejectedValue(new Error('authorization changed'));
    const res=response();await controller.handleStreamEndpoint(req,res,{ id:1,method:'tools/call',params:{ name:'search_knowledge' } });
    expect(res.write.mock.calls.every((call:any[]) => !String(call[0]).includes('authorized secret'))).toBe(true);
  });
  it('treats legacy protocol metadata as metadata rather than missing knowledge evidence', async () => {
    service.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } });
    const res = response();
    await controller.postMessage({ ...req, headers: { ...req.headers } }, res, undefined as any, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(withStrictOutputPermit).not.toHaveBeenCalled();
    expect(withStrictResourceOutput).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
  });
  it('passes the same explicit aggregate manifest through legacy and direct knowledge outputs', async () => {
    const manifest = [{ documentId: 'doc', version: 1 }];
    service.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ dependency_manifest: manifest }) }] } });
    await controller.postMessage({ ...req, headers: { ...req.headers } }, response(), undefined as any, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aggregate_knowledge_table' } });
    expect(withStrictOutputPermit).toHaveBeenCalledWith('reader', snapshot, expect.any(Function), manifest);
  });

  it('protects multipart upload confirmations with a fresh mutation resource permit', async () => {
    service.saveUploadAndEnqueue = jest.fn().mockResolvedValue({ document_id: 'first', documents: [{ document_id: 'first', title: 'old sensitive' }, { document_id: 'second' }], kb_name: 'old sensitive' });
    service.readResource = jest.fn().mockResolvedValue({ documents: [{ document_id: 'first', status: 'accepted' }, { document_id: 'second', status: 'accepted' }] });
    const res = response();
    await controller.uploadFile({ headers: { ...req.headers }, query: {} } as any, undefined as any, 'kb', undefined as any, { originalname: 'file.zip', buffer: Buffer.from('file') }, res);
    expect(withStrictResourceOutput).toHaveBeenCalledWith('reader', { ...snapshot, revision: '43' }, expect.any(Function), expect.any(Function));
    expect(service.readResource).toHaveBeenCalledWith('reader', { kind: 'mutation_receipt', args: { kb_id: 'kb', doc_ids: ['first', 'second'], action: 'upload' } }, {});
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('old sensitive');
  });

  it('refreshes only a completed mutation receipt after its own revision change', async () => {
    service.getResultResource = jest.fn().mockReturnValue({ kind: 'mutation_receipt', args: { action: 'delete_document' } });
    service.readResource = jest.fn().mockResolvedValue({ ok: true, documentId: 'deleted' });
    await controller.handleDirectRpc({ headers: { ...req.headers }, query: {} } as any, response(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_document' } });
    expect(withStrictResourceOutput).toHaveBeenCalledWith('reader', { ...snapshot, revision: '43' }, expect.any(Function), expect.any(Function));
  });

  it('rebuilds resource payloads under the same permit instead of emitting the pre-lock snapshot', async () => {
    service.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'stale private resource' }], structuredContent: { secret: 'stale private resource' } } });
    service.getResultResource = jest.fn().mockReturnValue({ kind: 'documents', args: {} });
    service.readResource = jest.fn().mockResolvedValue({ documents: [] });
    const res = response();
    await controller.handleDirectRpc({ headers: { ...req.headers }, query: {} } as any, res, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_documents' } });
    expect(withStrictResourceOutput).toHaveBeenCalledTimes(1);
    expect(service.readResource).toHaveBeenCalledWith('reader', { kind: 'documents', args: {} }, {});
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('stale private resource');
    expect(res.json.mock.calls[0][0].result.structuredContent).toEqual({ documents: [] });
  });

});
