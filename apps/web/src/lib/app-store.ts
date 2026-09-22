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
}

export const appStore: AppStore = {
  KNOWLEDGE_BASES: [],
  CONVERSATIONS: [],
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
};
