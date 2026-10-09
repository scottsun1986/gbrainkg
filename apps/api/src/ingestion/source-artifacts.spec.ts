import { mkdtemp,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistSourceArtifacts } from './source-artifacts';
describe('version-owned source artifacts',()=>{
  let root:string;const before=process.env.UPLOAD_ROOT;const realFetch=global.fetch;const instanceBefore=process.env.INSTANCE_ID;
  beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'source-artifact-'));process.env.UPLOAD_ROOT=root;});
  afterEach(async()=>{global.fetch=realFetch;if(instanceBefore===undefined)delete process.env.INSTANCE_ID;else process.env.INSTANCE_ID=instanceBefore;if(before===undefined)delete process.env.UPLOAD_ROOT;else process.env.UPLOAD_ROOT=before;await rm(root,{recursive:true,force:true});});
  it('copies unchanged old assets/facts into an independent new version',async()=>{
    await mkdir(join(root,'doc','artifacts.v1'),{recursive:true});await writeFile(join(root,'doc','artifacts.v1','facts'),'facts');await writeFile(join(root,'doc','artifacts.v1','image'),'image');
    const parsed=await persistSourceArtifacts({structured_tables:[{id:'t',artifact_path:'doc/artifacts.v1/facts',sha256:'stable'}],assets:[{id:'a',sha256:'stable',path:'doc/artifacts.v1/image'}]},'doc',2,'http://parser.invalid');
    expect(parsed.structured_tables[0].artifact_path).toMatch(/^doc\/artifacts.v2\//);expect(parsed.assets[0].url).toContain('version=2');
    await rm(join(root,'doc','artifacts.v1'),{recursive:true});expect(await readFile(join(root,parsed.assets[0].path),'utf8')).toBe('image');
  });
  it('rejects inherited references belonging to a different document',async()=>{
    await expect(persistSourceArtifacts({assets:[{id:'a',path:'doc/../foreign/private'}]},'doc',2,'http://parser.invalid')).rejects.toThrow('Invalid inherited asset owner');
  });
  it('binds artifact downloads to instance identity and clears temporary partial files',async()=>{
    const id='a'.repeat(32);process.env.INSTANCE_ID='fixture-instance';
    const fail=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('partial'));controller.error(new Error('connection lost'));}});
    const fetchMock=jest.fn().mockResolvedValue({ok:true,body:fail});global.fetch=fetchMock as any;
    await expect(persistSourceArtifacts({structured_tables:[{id:'t',artifact_id:id}]},'doc',3,'http://parser.invalid')).rejects.toThrow();
    expect(fetchMock.mock.calls[0][0]).toContain('instance_id=fixture-instance');expect((await readdir(join(root,'doc','artifacts.v3'))).some(name=>name.endsWith('.tmp'))).toBe(false);
    delete process.env.INSTANCE_ID;
  });
});
