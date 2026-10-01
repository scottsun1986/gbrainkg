import { graphProjection,communityInputFingerprint } from './incremental-projection';

describe('incremental graph projection', () => {
  const shard=(documentId:string,sourceHash:string) => ({ input:{ documentId,versionId:documentId+'-version',sourceHash },entities:[{ name:'shared spelling',type:'person' as const,description:'source-specific description' },{ name:documentId,type:'document' as const }],relations:[{ sourceName:'shared spelling',targetName:documentId,relationType:'mentions' as const,snippet:'original evidence' }] });
  it('retains distinct source contexts instead of merging descriptions based on spelling', () => {
    const projection=graphProjection([shard('a','a:1'),shard('b','b:1')]);
    const node=projection.nodes.find(row=>row.name==='shared spelling')!;
    expect(node.description).toBe('');expect(node.properties.canonicalKind).toBe('surface_form');
    expect(node.properties.sourceContexts).toHaveLength(2);expect(node.inputs).toHaveLength(2);
    expect(projection.edges.every(edge=>edge.inputs.length===2)).toBe(true);
  });
  it('changes only affected row identities and input hashes', () => {
    const old=graphProjection([shard('a','a:1'),shard('b','b:1')]);
    const updated=graphProjection([shard('a','a:2'),shard('b','b:1')]);
    expect(updated.nodes.find(node=>node.name==='b')!.properties.projectionHash).toBe(old.nodes.find(node=>node.name==='b')!.properties.projectionHash);
    expect(updated.nodes.find(node=>node.name==='shared spelling')!.properties.projectionHash).not.toBe(old.nodes.find(node=>node.name==='shared spelling')!.properties.projectionHash);
  });
  it('does not reuse a community solely because member IDs stayed the same', () => {
    const old=[{ id:'entity',description:'old',outgoingRelations:[] }];
    expect(communityInputFingerprint([{ ...old[0],description:'new' }])).not.toBe(communityInputFingerprint(old));
  });
});
