import { createHash } from 'node:crypto';
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

const FEISHU_DOMAIN_ALLOWLIST = new Set([
  'open.feishu.cn',
  'open.larksuite.com',
  'open.feishu.cn.',
  'open.larksuite.com.',
]);

function validateFeishuDomain(raw: string): string {
  const domain = raw.trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(domain)) {
    throw new Error('feishu domain must use HTTPS');
  }
  const hostname = domain.replace(/^https:\/\//i, '').split('/')[0].toLowerCase();
  const bareHostname = hostname.replace(/\.$/, '');
  if (!FEISHU_DOMAIN_ALLOWLIST.has(bareHostname)) {
    throw new Error(
      `feishu domain "${bareHostname}" is not in the allowlist (open.feishu.cn, open.larksuite.com)`,
    );
  }
  return domain;
}

export function readFeishuCredentials(
  config: Record<string, unknown>,
): FeishuCredentials {
  const appId = String(config.appId ?? config.app_id ?? '').trim();
  const appSecret = String(config.appSecret ?? config.app_secret ?? '').trim();
  if (!appId || !appSecret) {
    throw new Error('feishu credentials required: appId/appSecret');
  }
  const domain = validateFeishuDomain(
    String(config.domain ?? config.baseUrl ?? 'https://open.feishu.cn'),
  );
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

  private async listFiles(config:Record<string,unknown>,token:string): Promise<Array<{token:string;name:string;objectToken?:string;type?:string;revision?:string}>> {
    const { domain }=readFeishuCredentials(config);
    const spaceId=String(config.spaceId ?? config.space_id ?? '');
    if (this.mode==='feishu_wiki' && !spaceId) throw new Error('feishu_wiki requires spaceId');
    const modern=config.syncAcl===true || process.env.CORE_EXTERNAL_ACL_REQUIRED==='1' || process.env.CORE_AUTH_ENFORCE==='1';
    const files:Array<{token:string;name:string;objectToken?:string;type?:string;revision?:string}>=[];
    let page=''; const seen=new Set<string>();
    for (let index=0;index<100;index++) {
      const base=this.mode==='feishu_wiki' ? `${domain}/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?page_size=50` : `${domain}/open-apis/drive/v1/files?page_size=50${config.folderToken || config.folder_token ? `&folder_token=${encodeURIComponent(String(config.folderToken || config.folder_token))}` : ''}`;
      const response=await this.fetchFn(`${base}${page ? `&page_token=${encodeURIComponent(page)}`:''}`,{method:'GET',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
      const body=await response.json();
      if (!response.ok || (body.code!==undefined && body.code!==0)) throw new Error(`feishu list failed: ${body.msg || response.status}`);
      const rows=this.mode==='feishu_wiki' ? body.data?.items || [] : body.data?.files || [];
      for (const row of rows) {
        if (this.mode!=='feishu_wiki' && (row.type==='folder' || (!isTextishName(String(row.name || '')) && !(modern && row.type==='docx')))) continue;
        files.push({token:String(row.node_token || row.token || row.file_token || ''),name:String(row.title || row.name || 'document'),objectToken:row.obj_token,type:row.obj_type || row.type,revision:String(row.obj_edit_time || row.modified_time || '')});
      }
      if (!body.data?.has_more) return files;
      const next=String(body.data?.page_token || '');
      if (!next || seen.has(next)) throw new Error('Incomplete Feishu source pagination');
      seen.add(next);page=next;
    }
    throw new Error('Feishu snapshot page budget exceeded');
  }

  private async downloadRaw(
    config: Record<string, unknown>,
    token: string,
    fileToken: string,
    file?: { objectToken?: string; type?: string },
  ): Promise<string> {
    const { domain } = readFeishuCredentials(config);
    const headers = { Authorization: `Bearer ${token}` };
    const modern=config.syncAcl===true || process.env.CORE_EXTERNAL_ACL_REQUIRED==='1' || process.env.CORE_AUTH_ENFORCE==='1';
    if (modern && (file?.type==='docx' || this.mode==='feishu_wiki')) {
      let objectToken=file?.objectToken || fileToken;
      if (this.mode==='feishu_wiki' && !file?.objectToken) {
        const nodeResponse=await this.fetchFn(`${domain}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(fileToken)}`,{ headers,signal:AbortSignal.timeout(15000) });
        const node=await nodeResponse.json();
        if (!nodeResponse.ok || node.code!==0 || node.data?.node?.obj_type!=='docx') throw new Error('Unsupported source node content');
        objectToken=node.data.node.obj_token;
      }
      const rawResponse=await this.fetchFn(`${domain}/open-apis/docx/v1/documents/${encodeURIComponent(objectToken)}/raw_content`,{ headers,signal:AbortSignal.timeout(15000) });
      const raw=await rawResponse.json();
      if (!rawResponse.ok || raw.code!==0 || typeof raw.data?.content!=='string') throw new Error('Feishu source content unavailable');
      return raw.data.content;
    }
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

  private async sourceAcl(config: Record<string,unknown>, token:string, file:{ token:string; objectToken?:string; type?:string }) {
    const { domain }=readFeishuCredentials(config);
    try {
      const response=await this.fetchFn(`${domain}/open-apis/drive/v1/permissions/${encodeURIComponent(file.objectToken || file.token)}/members?type=${encodeURIComponent(file.type || (this.mode==='feishu_wiki' ? 'wiki':'file'))}`,{ headers:{ Authorization:`Bearer ${token}` },signal:AbortSignal.timeout(15000) });
      const body=await response.json();
      if (!response.ok || body.code!==0 || !Array.isArray(body.data?.items) || body.data?.has_more) throw new Error('Incomplete source ACL');
      const subjects=body.data.items.filter((row:any) => ['view','edit','full_access'].includes(row.perm)).map((row:any) => ({ type:String(row.member_type),id:String(row.member_id) })).sort((a:any,b:any) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
      return { revision:createHash('sha256').update(JSON.stringify(subjects)).digest('hex'),verified:true,subjects };
    } catch { return { revision:'unavailable',verified:false,subjects:[] }; }
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
    const syncAcl = config.syncAcl === true || process.env.CORE_EXTERNAL_ACL_REQUIRED === '1' || process.env.CORE_AUTH_ENFORCE === '1';
    const pending = syncAcl ? sorted : sorted.filter((f) => f.token > after);

    const changes: ConnectorChange[] = [];
    let nextCursor = after;
    for (const file of pending) {
      let content = '';
      const externalAcl = syncAcl ? await this.sourceAcl(config,token,file) : undefined;
      try {
        content = await this.downloadRaw(config, token, file.token, file);
      } catch {
        if (syncAcl) changes.push({ externalId:file.token,title:file.name,content:'',aclOnly:true,externalAcl:{ revision:'unavailable',verified:false,subjects:[] } });
        break;
      }
      changes.push({
        externalId: file.token,
        title: file.name,
        content,
        ...(externalAcl ? { externalAcl,externalRevision:file.revision || externalAcl.revision } : {}),
        metadata: { mode: this.mode },
      });
      nextCursor = file.token;
    }
    return { changes, nextCursor: nextCursor || after || null, ...(syncAcl ? { snapshotIds:files.map(f => f.token) } : {}) };
  }
}
