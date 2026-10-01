import { createHash } from 'node:crypto';
export interface OriginalSpanBlock { id: string; versionId: string; charStart: number; charEnd: number; rawHash: string; rawContent: string | null }
export function originalSpan(text: string, start: number, end: number): string {
  if (![start,end].every(Number.isInteger) || start<0 || end<=start || end>text.length) throw new Error('Original span is outside parsed source');
  return text.slice(start,end);
}
/** Retain the published immutable block; attach only a separately verified source snapshot. */
export async function hydrateOriginalSnapshots<T extends OriginalSpanBlock>(db: any, blocks: T[]): Promise<T[]> {
  const missing=blocks.filter(block=>block.rawContent==null);
  if (!missing.length || !db.originalBlockSnapshot?.findMany) return blocks;
  const snapshots=await db.originalBlockSnapshot.findMany({ where:{ blockId:{ in:missing.map(block=>block.id) } } });
  const byId=new Map<string,any>(snapshots.map((row:any)=>[row.blockId,row]));
  return blocks.map(block=>{
    const row=byId.get(block.id);
    if (block.rawContent!=null || !row || row.versionId!==block.versionId || row.charStart!==block.charStart || row.charEnd!==block.charEnd || typeof row.rawContent!=='string' || createHash('sha256').update(row.rawContent).digest('hex')!==row.rawHash) return block;
    return { ...block,rawContent:row.rawContent,rawHash:row.rawHash };
  });
}
