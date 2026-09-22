import {
  ConnectorChange,
  EnterpriseConnector,
  FetchChangesResult,
} from './types';

export type FetchLike = (url: string, init?: any) => Promise<any>;

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: string;
}

export function readFeishuCredentials(
  config: Record<string, unknown>,
): FeishuCredentials {
  const appId = String(config.appId ?? config.app_id ?? '').trim();
  const appSecret = String(config.appSecret ?? config.app_secret ?? '').trim();
  if (!appId || !appSecret) {
    throw new Error('feishu credentials required: appId/appSecret');
  }
  const domain = String(
    config.domain ?? config.baseUrl ?? 'https://open.feishu.cn',
  )
    .trim()
    .replace(/\/$/, '');
  return { appId, appSecret, domain };
}

/** 获取 tenant_access_token；凭据缺失直接抛错。 */
export async function getTenantAccessToken(
  config: Record<string, unknown>,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<string> {
  const { appId, appSecret, domain } = readFeishuCredentials(config);
  const res = await fetchFn(
    `${domain}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  const data: any = await res.json();
  if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
    throw new Error(
      `feishu tenant_access_token failed: ${data?.msg || res.status}`,
    );
  }
  const token = String(data?.tenant_access_token || '');
  if (!token) throw new Error('feishu tenant_access_token missing in response');
  return token;
}

function isTextishName(name: string): boolean {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.docx');
}

/**
 * 飞书连接器：drive 文件夹 / wiki 空间 列表 + 原文下载。
 * cursor = 已处理的最大 token（字典序），同一 cursor 幂等。
 */
export class FeishuConnector implements EnterpriseConnector {
  readonly kind: string;

  constructor(
    private readonly mode: 'feishu_drive' | 'feishu_wiki' = 'feishu_drive',
    private readonly fetchFn: FetchLike = globalThis.fetch,
  ) {
    this.kind = mode;
  }

  async testConnection(config: Record<string, unknown>): Promise<void> {
    // 无凭据必须报错；有凭据则验证 token 接口连通性。
    await getTenantAccessToken(config, this.fetchFn);
  }

  private async listFiles(
    config: Record<string, unknown>,
    token: string,
  ): Promise<Array<{ token: string; name: string }>> {
    const { domain } = readFeishuCredentials(config);
    const headers = { Authorization: `Bearer ${token}` };
    if (this.mode === 'feishu_wiki') {
      const spaceId = String(config.spaceId ?? config.wikiSpaceId ?? '');
      if (!spaceId) throw new Error('feishu wiki requires spaceId');
      const res = await this.fetchFn(
        `${domain}/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?page_size=50`,
        { method: 'GET', headers },
      );
      const data: any = await res.json();
      if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
        throw new Error(`feishu wiki list failed: ${data?.msg || res.status}`);
      }
      const items: any[] = data?.data?.items || [];
      return items.map((item) => ({
        token: String(item.node_token || item.obj_token || item.token || ''),
        name: String(item.title || item.name || 'wiki-node'),
      }));
    }
    const folderToken = String(config.folderToken ?? config.folder_token ?? '');
    const url = `${domain}/open-apis/drive/v1/files?page_size=50${
      folderToken ? `&folder_token=${encodeURIComponent(folderToken)}` : ''
    }`;
    const res = await this.fetchFn(url, { method: 'GET', headers });
    const data: any = await res.json();
    if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
      throw new Error(`feishu drive list failed: ${data?.msg || res.status}`);
    }
    const files: any[] = data?.data?.files || [];
    return files
      .filter((file) => file?.type !== 'folder' && isTextishName(String(file?.name || '')))
      .map((file) => ({
        token: String(file.token || file.file_token || ''),
        name: String(file.name || 'file'),
      }));
  }

  private async downloadRaw(
    config: Record<string, unknown>,
    token: string,
    fileToken: string,
  ): Promise<string> {
    const { domain } = readFeishuCredentials(config);
    const headers = { Authorization: `Bearer ${token}` };
    const url =
      this.mode === 'feishu_wiki'
        ? `${domain}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(fileToken)}`
        : `${domain}/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/raw`;
    const res = await this.fetchFn(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`feishu download failed: ${res.status}`);
    }
    if (typeof res.text === 'function') {
      return res.text();
    }
    const data: any = await res.json();
    return String(data?.data?.content ?? data?.content ?? '');
  }

  async fetchChanges(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<FetchChangesResult> {
    const token = await getTenantAccessToken(config, this.fetchFn);
    const files = (await this.listFiles(config, token)).filter((f) => f.token);
    // 字典序游标保证同一 cursor 结果稳定（幂等）
    const sorted = [...files].sort((a, b) =>
      a.token < b.token ? -1 : a.token > b.token ? 1 : 0,
    );
    const after = cursor && cursor.trim() ? cursor.trim() : '';
    const pending = sorted.filter((f) => f.token > after);

    const changes: ConnectorChange[] = [];
    let nextCursor = after;
    for (const file of pending) {
      let content = '';
      try {
        content = await this.downloadRaw(config, token, file.token);
      } catch {
        continue;
      }
      changes.push({
        externalId: file.token,
        title: file.name,
        content,
        metadata: { mode: this.mode },
      });
      nextCursor = file.token;
    }
    return { changes, nextCursor: nextCursor || after || null };
  }
}
