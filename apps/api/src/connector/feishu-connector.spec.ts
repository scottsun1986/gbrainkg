import {
  FeishuConnector,
  getTenantAccessToken,
  readFeishuCredentials,
} from './feishu-connector';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async (): Promise<string> => String((body as any)?.content ?? ''),
  };
}

describe('readFeishuCredentials', () => {
  it('throws when credentials are missing', () => {
    expect(() => readFeishuCredentials({})).toThrow(/credentials required/);
    expect(() => readFeishuCredentials({ appId: 'cli_x' })).toThrow(
      /credentials required/,
    );
    expect(() => readFeishuCredentials({ appSecret: 'sec' })).toThrow(
      /credentials required/,
    );
  });

  it('accepts app_id/app_secret aliases and normalizes domain', () => {
    const creds = readFeishuCredentials({
      app_id: 'cli_x',
      app_secret: 'sec',
      domain: 'https://open.feishu.cn/',
    });
    expect(creds).toEqual({
      appId: 'cli_x',
      appSecret: 'sec',
      domain: 'https://open.feishu.cn',
    });
  });
});

describe('getTenantAccessToken', () => {
  it('rejects when no credentials are configured', async () => {
    await expect(getTenantAccessToken({}, jest.fn())).rejects.toThrow(
      /credentials required/,
    );
  });

  it('POSTs app_id/app_secret and returns tenant_access_token', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({ code: 0, tenant_access_token: 't-abc' }),
    );
    const token = await getTenantAccessToken(
      { appId: 'cli_x', appSecret: 'sec' },
      fetchFn as any,
    );
    expect(token).toBe('t-abc');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ app_id: 'cli_x', app_secret: 'sec' }),
      }),
    );
  });

  it('throws when feishu returns an error code', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({ code: 99991663, msg: 'invalid app_id' }),
    );
    await expect(
      getTenantAccessToken({ appId: 'cli_x', appSecret: 'bad' }, fetchFn as any),
    ).rejects.toThrow(/tenant_access_token failed/);
  });
});

describe('FeishuConnector.fetchChanges', () => {
  it('lists drive files and downloads raw content, cursor = max token', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 't-abc' });
      }
      if (url.includes('/drive/v1/files') && url.includes('/raw')) {
        return { ok: true, status: 200, text: async (): Promise<string> => 'doc body' };
      }
      if (url.includes('/drive/v1/files')) {
        return jsonResponse({
          code: 0,
          data: {
            files: [
              { token: 'tok-b', name: 'b.md', type: 'docx' },
              { token: 'tok-a', name: 'a.txt', type: 'docx' },
              { token: 'tok-c', name: 'c.png', type: 'file' },
            ],
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const connector = new FeishuConnector('feishu_drive', fetchFn as any);
    const result = await connector.fetchChanges(
      { appId: 'cli_x', appSecret: 'sec' },
      null,
    );

    // sorted by token: tok-a, tok-b；png 被过滤
    expect(result.changes.map((c) => c.externalId)).toEqual(['tok-a', 'tok-b']);
    expect(result.nextCursor).toBe('tok-b');

    // 幂等：同一 cursor 不再返回已处理 token
    const again = await connector.fetchChanges(
      { appId: 'cli_x', appSecret: 'sec' },
      result.nextCursor,
    );
    expect(again.changes).toEqual([]);
    expect(again.nextCursor).toBe('tok-b');
  });

  it('testConnection surfaces missing credentials', async () => {
    const connector = new FeishuConnector('feishu_drive', jest.fn() as any);
    await expect(connector.testConnection({})).rejects.toThrow(
      /credentials required/,
    );
  });

  it('wiki mode requires spaceId and lists nodes', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 't-abc' });
      }
      if (url.includes('/wiki/v2/spaces/') && url.includes('/nodes')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ node_token: 'node-1', title: 'Node 1' }],
          },
        });
      }
      if (url.includes('/wiki/v2/spaces/get_node')) {
        return jsonResponse({ code: 0, data: { content: 'wiki body' } });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const connector = new FeishuConnector('feishu_wiki', fetchFn as any);
    await expect(
      connector.fetchChanges({ appId: 'a', appSecret: 's' }, null),
    ).rejects.toThrow(/spaceId/);

    const result = await connector.fetchChanges(
      { appId: 'a', appSecret: 's', spaceId: 'space-1' },
      null,
    );
    expect(result.changes[0]).toMatchObject({
      externalId: 'node-1',
      title: 'Node 1',
    });
  });
});

describe('Feishu source ACL synchronization', () => {
  function sourceFetch(permissionFailure = false, contentFailure = false) {
    return jest.fn(async (url: string) => {
      if (url.includes('tenant_access_token')) return jsonResponse({ code:0,tenant_access_token:'test' });
      if (url.includes('/drive/v1/files')) return jsonResponse({ code:0,data:{ files:[{ token:'same-id',name:'native doc',type:'docx' }],has_more:false } });
      if (url.includes('/permissions/')) return permissionFailure ? jsonResponse({ code:999,msg:'denied' },false,403) : jsonResponse({ code:0,data:{ items:[{ member_type:'openid',member_id:'source-reader',perm:'view' }] } });
      if (url.includes('/raw_content')) return contentFailure ? jsonResponse({},false,503) : jsonResponse({ code:0,data:{ content:'unchanged body' } });
      throw new Error('Unexpected source request');
    });
  }
  const config = { appId:'test',appSecret:'test',syncAcl:true };
  it('rechecks permissions even when the cursor and content are unchanged', async () => {
    const connector = new FeishuConnector('feishu_drive',sourceFetch() as any);
    const first = await connector.fetchChanges(config,null);
    const second = await connector.fetchChanges(config,first.nextCursor);
    expect(second.snapshotIds).toEqual(['same-id']);
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0].externalAcl).toMatchObject({ verified:true,subjects:[{ type:'openid',id:'source-reader' }] });
  });
  it('records unreadable ACL as unavailable instead of preserving authorization', async () => {
    const connector = new FeishuConnector('feishu_drive',sourceFetch(true) as any);
    const result = await connector.fetchChanges(config,null);
    expect(result.changes[0].externalAcl).toMatchObject({ verified:false,subjects:[] });
  });
  it('emits a closed ACL update when source content cannot be fetched', async () => {
    const connector = new FeishuConnector('feishu_drive',sourceFetch(false,true) as any);
    const result = await connector.fetchChanges(config,null);
    expect(result.changes[0]).toMatchObject({ aclOnly:true,externalAcl:{ verified:false } });
  });
});
