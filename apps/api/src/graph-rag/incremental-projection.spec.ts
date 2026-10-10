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
    // The relation endpoint is ambiguous even inside its own source context
    // (one label, two kinds). Entity identity must not be adjudicated by node
    // order (B05): the edge is skipped and counted as unresolved instead of
    // being silently attached to a sorted-first node.
    expect(projection.edges).toHaveLength(0);
    expect(projection.unresolvedRelations).toBe(1);
  });
  it('merges relations on entity identity so cross-type homonyms keep separate edges (B05)', () => {
    // Document A: Mercury the planet; document B: Mercury the element. The raw
    // spellings are identical, so the old raw-name edge key collapsed both
    // facts onto one edge and attached both documents' provenance to it.
    const shard=(documentId:string,type:'system'|'organization') => ({ input:{ documentId,versionId:`${documentId}-version`,sourceHash:`${documentId}:1` },
      entities:[{ name:'Mercury',type },{ name:'X',type:'concept' as const }],
      relations:[{ sourceName:'Mercury',targetName:'X',relationType:'relates_to' as const,snippet:`evidence from ${documentId}` }] });
    const projection=graphProjection([shard('a','system'),shard('b','organization')]);
    expect(projection.nodes.filter(node=>node.name==='Mercury').map(node=>node.type).sort()).toEqual(['organization','system']);
    expect(projection.edges).toHaveLength(2);
    const planetEdge=projection.edges.find(edge=>edge.sourceKey==='mercury|system')!;
    const elementEdge=projection.edges.find(edge=>edge.sourceKey==='mercury|organization')!;
    expect(planetEdge.provenance).toHaveLength(1);
    expect(planetEdge.provenance[0].documentId).toBe('a');
    expect(elementEdge.provenance).toHaveLength(1);
    expect(elementEdge.provenance[0].documentId).toBe('b');
    expect(projection.unresolvedRelations).toBe(0);
  });
  it('keeps case-variant relations of a merged same-type entity (B05)', () => {
    // A writes "Alpha", B writes "alpha": the nodes merge on the normalized
    // key, and B's relation must survive instead of being dropped for
    // referencing a spelling that never appears as a stored node name.
    const projection=graphProjection([
      { input:{ documentId:'a',versionId:'a-version',sourceHash:'a:1' },
        entities:[{ name:'Alpha',type:'system' as const },{ name:'Beta',type:'system' as const }],
        relations:[{ sourceName:'Alpha',targetName:'Beta',relationType:'depends_on' as const,snippet:'A evidence' }] },
      { input:{ documentId:'b',versionId:'b-version',sourceHash:'b:1' },
        entities:[{ name:'alpha',type:'system' as const },{ name:'beta',type:'system' as const }],
        relations:[{ sourceName:'alpha',targetName:'beta',relationType:'depends_on' as const,snippet:'B evidence' }] },
    ]);
    expect(projection.nodes.filter(node=>node.name.toLowerCase()==='alpha')).toHaveLength(1);
    expect(projection.edges).toHaveLength(1);
    const edge=projection.edges[0];
    expect(edge.sourceKey).toBe('alpha|system');
    expect(edge.targetKey).toBe('beta|system');
    expect(edge.provenance.map(item=>item.documentId).sort()).toEqual(['a','b']);
    expect(projection.unresolvedRelations).toBe(0);
  });
  it('does not reuse a community solely because member IDs stayed the same', () => {
    const old=[{ id:'entity',description:'old',outgoingRelations:[] }];
    expect(communityInputFingerprint([{ ...old[0],description:'new' }])).not.toBe(communityInputFingerprint(old));
  });
});
