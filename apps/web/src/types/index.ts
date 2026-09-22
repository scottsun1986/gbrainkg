/** Shared domain types for the web client. */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface OrgNodeRef {
  id: string;
  name: string;
  path?: string;
}

export interface KbAdminRef {
  n?: string;
  i?: string;
}

export interface KbInfo {
  id: string;
  type: string;
  name: string;
  desc: string;
  docs: number;
  canWrite: boolean;
  canManage: boolean;
  canGrant: boolean;
  canDelete: boolean;
  admins: KbAdminRef[];
  visibility: string;
  owner: string;
  [key: string]: unknown;
}

export interface ConversationSummary {
  id: string;
  title?: string;
  createdAt?: string;
  kb?: string;
  [key: string]: unknown;
}

export interface UserOrgMembership {
  orgNode?: OrgNodeRef | null;
}

export interface UserRoleRef {
  role?: { name?: string } | null;
}

export interface UserRow {
  id: string;
  name: string;
  initials: string;
  email: string;
  t: string;
  roles: string[];
  status: string;
  org: string;
  orgPath: string;
  orgs: string[];
  orgNodes: OrgNodeRef[];
  orgIds: string[];
  canManage: boolean;
  [key: string]: unknown;
}

export interface RoleRow {
  id: string;
  name: string;
  desc: string;
  perms: string[];
  users?: number;
  builtin?: boolean;
  [key: string]: unknown;
}

export interface IndustryKbRow {
  id: string;
  name: string;
  type: string;
  desc: string;
  docs: number;
  created: string;
  admins: KbAdminRef[];
  grants: number;
  canManage: boolean;
  canGrant: boolean;
  canDelete: boolean;
  [key: string]: unknown;
}

export interface GrantRow {
  id: string;
  kbId: string;
  subjectId: string;
  subjectType: string;
  subj: string;
  type: string;
  exp: string;
  scope: string;
  [key: string]: unknown;
}

export interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  url: string;
  note: string;
  keyMask?: string;
  secretKeyMask?: string;
  hasApiKey?: boolean;
  hasSecretKey?: boolean;
  defaultParams?: { note?: string; gbrainRecipe?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ModelRow {
  id: string;
  name: string;
  kind: string;
  provider: string;
  ctx: string;
  dim: string;
  default: boolean;
  tested: boolean;
  modelName?: string;
  providerId?: string;
  contextLen?: number | string;
  dimensions?: number | string;
  isDefault?: boolean;
  [key: string]: unknown;
}

export interface ModelGroups {
  llm: ModelRow[];
  fast_llm: ModelRow[];
  embedding: ModelRow[];
  rerank: ModelRow[];
}

export interface AuditRow {
  id: string;
  when: string;
  what: string;
  actor: string;
  [key: string]: unknown;
}

export interface OrgTreeNode {
  id: string;
  name: string;
  path: string;
  parentId?: string | null;
  expanded?: boolean;
  canManage?: boolean;
  canCreateChild?: boolean;
  kbs: string[];
  knowledgeBase: { id: string; name?: string; [key: string]: unknown } | null;
  admins: string[];
  children: OrgTreeNode[];
  [key: string]: unknown;
}

export interface Citation {
  id: string;
  citationIndex: number;
  title: string;
  kb: string;
  documentId: string;
  kbName: string;
  truth: string;
  evidences: number;
  lastUpdate: string;
  snippet: string;
  path: string;
  pageNo?: number | string;
  page_no?: number | string;
  bbox?: { x: number; y: number; w?: number; h?: number } | null;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  done?: boolean;
  sources?: Citation[];
  trace?: TraceNode[];
  traceId?: string;
}

export interface TraceNode {
  id: string;
  label?: string;
  name?: string;
  status?: string;
  summary?: string;
  details?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

export interface PreviewTarget {
  kbId?: string;
  kb?: string;
  docId?: string;
  documentId?: string;
  id?: string;
  title?: string;
  snippet?: string;
  initialTab?: string;
  topic?: string;
  pageNo?: number | string;
  bbox?: { x: number; y: number; w?: number; h?: number } | null;
  [key: string]: unknown;
}

export interface DocChunk {
  id: string;
  content?: string;
  ord?: number;
  tokenCount?: number;
  [key: string]: unknown;
}

export interface DocMeta {
  id?: string;
  title?: string;
  status?: string;
  hasRawFile?: boolean;
  mdPath?: string;
  kbId?: string;
  chunkCount?: number;
  parserEngine?: string;
  parserClassification?: string;
  qualityStatus?: string;
  qualityScore?: number;
  qualityIssues?: string[];
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  [key: string]: unknown;
}

export interface DocDetail {
  document?: DocMeta;
  chunks?: DocChunk[];
  markdown_content?: string;
  [key: string]: unknown;
}

export interface CompileTruthSource {
  sourceKey: string;
  kind?: string;
  syncedVersion?: number | string;
  syncedAt?: string;
  lastSyncAt?: string;
}

export interface CompileTruthLatestJob {
  trigger?: string;
  status?: string;
  completedAt?: string | null;
}

export interface CompileTruthBody {
  state?: string;
  topicSlug?: string;
  mdPath?: string;
  lastCompiledAt?: string | null;
  brainRepoLastCompileAt?: string | null;
  sources?: CompileTruthSource[];
  latestJob?: CompileTruthLatestJob | null;
}

export interface CompileTruthPayload {
  document?: { status?: string; chunkCount?: number; version?: number | string } | null;
  compileTruth?: CompileTruthBody | null;
}

export interface TagItem {
  id: string;
  n?: string;
  name?: string;
  sub?: string;
  org?: string;
  [key: string]: unknown;
}

export interface CtxMenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export interface ToastState {
  text: string;
  undo: { label: string; fn: () => void } | null;
}

export interface CurrentUser {
  id?: string;
  username?: string;
  displayName?: string;
  email?: string;
  mustChangePassword?: boolean;
  orgs?: UserOrgMembership[];
  roles?: UserRoleRef[];
  [key: string]: unknown;
}

export type AdminData = Record<string, unknown> & {
  kbs?: unknown[];
  users?: unknown[];
  orgs?: unknown[];
  roles?: unknown[];
  grants?: unknown[];
  providers?: unknown[];
  models?: unknown[];
  audit?: unknown[];
  auditPagination?: Pagination | null;
  dream?: unknown;
  systemStatus?: unknown;
  capabilities?: unknown;
  managedIndustryKbs?: unknown[];
  user?: CurrentUser | null;
  error?: string;
};
