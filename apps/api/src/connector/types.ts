/** 企业连接器统一契约：拉取变更 → 入库 → 写 cursor。 */
export type ConnectorKind =
  | 'git'
  | 'feishu_drive'
  | 'feishu_wiki'
  | 'generic_webhook';

export interface ConnectorChange {
  /** 源系统稳定 ID（git: 相对路径；feishu: file/node token；webhook: externalId） */
  externalId: string;
  title: string;
  content: string;
  /** true = 源端删除 */
  deleted?: boolean;
  aclOnly?: boolean;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  externalRevision?: string;
  externalAcl?: { revision: string; verified?: boolean; public?: boolean; subjects: Array<{ type: string; id: string }> };
}

export interface FetchChangesResult {
  changes: ConnectorChange[];
  snapshotIds?: string[];
  /** 下次拉取的游标；null 表示源不支持游标 */
  nextCursor: string | null;
  /**
   * 单项失败（B04）：内容下载或权限读取失败的对象。同步编排必须把
   * 部分失败表达为 partial/failed，不得记录成全部成功；失败项之外的
   * 对象仍要继续处理（尤其是撤权同步）。
   */
  failures?: Array<{ externalId: string; error: string }>;
}

export interface EnterpriseConnector {
  readonly kind: string;
  /** 无凭据 / 不可达时必须抛错 */
  testConnection(config: Record<string, unknown>): Promise<void>;
  /**
   * 按 cursor 增量拉取。同一 cursor 必须返回同一集合（幂等），
   * 且不得把已处理变更再次作为新增返回。
   */
  fetchChanges(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<FetchChangesResult>;
}

export function sourceTypeForKind(kind: string): string {
  if (kind === 'git') return 'git';
  if (kind === 'feishu_drive' || kind === 'feishu_wiki') return 'feishu';
  return 'import';
}
