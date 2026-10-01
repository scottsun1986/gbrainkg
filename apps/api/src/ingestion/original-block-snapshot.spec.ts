import { createHash } from 'node:crypto';
import { hydrateOriginalSnapshots, originalSpan } from './original-block-snapshot';
describe('legacy original source snapshots',()=>{
 const block={id:'b',versionId:'v',charStart:1,charEnd:5,rawHash:'index-hash',rawContent:null};
 const row={blockId:'b',versionId:'v',charStart:1,charEnd:5,rawContent:'原文😀',rawHash:createHash('sha256').update('原文😀').digest('hex')};
 const db=(snapshot:any)=>({originalBlockSnapshot:{findMany:jest.fn().mockResolvedValue([snapshot])}});
 it('retains UTF-16 offsets and rejects truncated or invalid source spans',()=>{
  expect(originalSpan('X原文😀Y',1,5)).toBe('原文😀');
  for(const [start,end] of [[-1,2],[1,8],[3,3],[.5,2]])expect(()=>originalSpan('abcd',start,end)).toThrow();
 });
 it('attaches source content without changing IDs, published inputs or the caller block',async()=>{
  const [actual]=await hydrateOriginalSnapshots(db(row),[block]);expect(actual.rawContent).toBe('原文😀');expect(actual.id).toBe('b');expect(block.rawContent).toBeNull();
 });
 it.each([{versionId:'wrong'},{charStart:0},{rawContent:'tampered'},{rawHash:'wrong'}])('rejects mismatched provenance %j',async(change)=>{
  expect((await hydrateOriginalSnapshots(db({...row,...change}),[block]))[0].rawContent).toBeNull();
 });
 it('does not replace a modern immutable original',async()=>{
  const modern={...block,rawContent:'modern'};const client=db(row);expect((await hydrateOriginalSnapshots(client,[modern]))[0]).toBe(modern);expect(client.originalBlockSnapshot.findMany).not.toHaveBeenCalled();
 });
});
