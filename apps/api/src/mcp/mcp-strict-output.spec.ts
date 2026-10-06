import { EventEmitter } from 'node:events';
import { McpController } from './mcp.controller';
import { runWithRequestContext,getRequestContext } from '../observability/request-context';
import { withStrictOutputPermit } from '../permission/strict-output-permit';
const snapshot = { revision:'42',policyVersion:'core-auth-v1',expiresAt:Infinity };
jest.mock('../prisma', () => ({ getPrismaClient: () => ({}) }));
jest.mock('../permission/authorization-revision', () => ({
  authorizationEnforced: () => true,
  withAuthorizedRequest:(userId:string,work:any) => runWithRequestContext({ requestId:'mcp-test',userId },()=>work(snapshot)),
  assertAuthorizationSnapshot:jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../permission/strict-output-permit', () => ({ withStrictOutputPermit:jest.fn() }));

describe('strict MCP transports', () => {
  const previous = process.env.KNOWLEDGE_STRICT_OUTPUT;
  let controller: McpController;
  let approved: boolean;
  let service: any;
  beforeEach(() => {
    jest.clearAllMocks();process.env.KNOWLEDGE_STRICT_OUTPUT='1';approved=false;
    (withStrictOutputPermit as jest.Mock).mockImplementation(async (_user,_snapshot,emit) => { approved=true;await emit();approved=false; });
    service={ handleJsonRpc:jest.fn(async () => { expect(getRequestContext()?.userId).toBe('reader');return { jsonrpc:'2.0',id:1,result:{ content:[{ text:'authorized secret' }] } }; }) };
    controller=new McpController(service,{ verifyCredential:jest.fn().mockResolvedValue({ user:{ id:'reader' } }) } as any,{ check:()=>({ allowed:true }) } as any,{} as any);
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
});
