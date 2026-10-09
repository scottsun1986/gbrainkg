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
  it('keeps same-name entities of different kinds as separate nodes (F05)', () => {
    const projection=graphProjection([{ input:{ documentId:'a',versionId:'a-version',sourceHash:'a:1' },
      entities:[
        { name:'同名实体',type:'system' as const,description:'系统' },
        { name:'同名实体',type:'organization' as const,description:'组织' },
        { name:'a',type:'document' as const },
      ],
      relations:[{ sourceName:'同名实体',targetName:'a',relationType:'mentions' as const,snippet:'source' }] }]);
    const named=projection.nodes.filter(node=>node.name==='同名实体');
    expect(named).toHaveLength(2);
    expect(named.map(node=>node.type).sort()).toEqual(['organization','system']);
    // The relation endpoint is ambiguous by label alone; the projection must
    // still resolve deterministically and never crash on the duplicate label.
    const edge=projection.edges[0];
    expect(edge.sourceKey).toBe('同名实体|organization');
    expect(edge.targetKey).toBe('a|document');
  });
  it('does not reuse a community solely because member IDs stayed the same', () => {
    const old=[{ id:'entity',description:'old',outgoingRelations:[] }];
    expect(communityInputFingerprint([{ ...old[0],description:'new' }])).not.toBe(communityInputFingerprint(old));
  });
});
