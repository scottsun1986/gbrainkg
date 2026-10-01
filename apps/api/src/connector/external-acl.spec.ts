import { syncExternalAcl } from './external-acl';

describe('external permissions map only to configured local subjects', () => {
  const tx = { document:{ update:jest.fn() },documentAcl:{ deleteMany:jest.fn(),createMany:jest.fn() },brainChangeEvent:{ create:jest.fn() } };
  beforeEach(() => jest.clearAllMocks());
  it('does not turn an external public flag into local inheritance', async () => {
    await syncExternalAcl(tx,'doc',{}, { externalId:'id',title:'doc',content:'',externalAcl:{ revision:'r',public:true,verified:true,subjects:[] } });
    expect(tx.document.update).toHaveBeenCalledWith(expect.objectContaining({ data:expect.objectContaining({ aclMode:'restricted',sourceAclSyncStatus:'pending_mapping' }) }));
    expect(tx.documentAcl.createMany).not.toHaveBeenCalled();
  });
  it('clears previous grants when source ACL is unavailable, including explicit inheritance mappings', async () => {
    await syncExternalAcl(tx,'doc',{ aclMapping:{ mode:'inherit' } },{ externalId:'id',title:'doc',content:'',externalAcl:{ revision:'unavailable',verified:false,subjects:[] } });
    expect(tx.document.update).toHaveBeenCalledWith(expect.objectContaining({ data:expect.objectContaining({ aclMode:'restricted',sourceAclSyncStatus:'source_acl_unavailable' }) }));
    expect(tx.documentAcl.deleteMany).toHaveBeenCalledWith({ where:{ documentId:'doc' } });
    expect(tx.brainChangeEvent.create).toHaveBeenCalled();
  });
});
