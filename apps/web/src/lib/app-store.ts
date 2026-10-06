/**
 * Session-scoped render caches shared across screens.
 * These are NOT the business data source — App refreshes them from the API and
 * screens read/update them so multi-screen mounts stay consistent.
 */
import type {
  AuditRow,
  ConversationSummary,
  GrantRow,
  IndustryKbRow,
  KbInfo,
  ModelGroups,
  OrgTreeNode,
  Pagination,
  ProviderRow,
  RoleRow,
  UserRow,
} from '@/types';

export interface AppStore {
  KNOWLEDGE_BASES: KbInfo[];
  CONVERSATIONS: ConversationSummary[];
  /** Older pages of the conversation list, loaded on demand by the sidebar. */
  CONVERSATIONS_META: { nextCursor: string | null; hasMore: boolean };
  CITATIONS: unknown[];
  DOCS: unknown[];
  ORG_TREE: OrgTreeNode | null;
  ORG_TREES: OrgTreeNode[];
  GRANTS: GrantRow[];
  MODELS: ModelGroups;
  AUDIT: AuditRow[];
  AUDIT_META: Pagination;
  DREAM: unknown;
  SYSTEM_STATUS: unknown;
  USERS: UserRow[];
  ROLES: RoleRow[];
  INDUSTRY_KBS: IndustryKbRow[];
  PROVIDERS: ProviderRow[];
  CAPABILITIES: string[];
  /** 当前登录用户是否持有“超级管理员”角色（用于“行业库创建者”授予等仅超管动作）。 */
  IS_SUPER_ADMIN: boolean;
}

export const appStore: AppStore = {
  KNOWLEDGE_BASES: [],
  CONVERSATIONS: [],
  CONVERSATIONS_META: { nextCursor: null, hasMore: false },
  CITATIONS: [],
  DOCS: [],
  ORG_TREE: null,
  ORG_TREES: [],
  GRANTS: [],
  MODELS: { llm: [], fast_llm: [], embedding: [], rerank: [] },
  AUDIT: [],
  AUDIT_META: { page: 1, limit: 20, total: 0, totalPages: 1 },
  DREAM: null,
  SYSTEM_STATUS: null,
  USERS: [],
  ROLES: [],
  INDUSTRY_KBS: [],
  PROVIDERS: [],
  CAPABILITIES: [],
  IS_SUPER_ADMIN: false,
};
