import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { asArray, asRecord, str, num } from '@/lib/errors';

/** 行业库选择场景的候选主体（人员/角色/组织）。 */
export interface SubjectOption {
  id: string;
  name: string;
  sub?: string;
  kw?: string;
}

/** 候选人员：附带所属组织节点 id（用于按组织层级分组）。 */
export interface SubjectUser extends SubjectOption {
  orgIds?: string[];
}

/** 候选组织：附带层级信息（parentId）以还原组织树。 */
export interface SubjectOrg extends SubjectOption {
  path?: string;
  parentId?: string | null;
}

export interface IndustrySubjectCatalog {
  users: SubjectUser[];
  roles: SubjectOption[];
  orgs: SubjectOrg[];
}

// 行业库授权/库管理员选择要求“任何”主体，范围不随操作者组织范围收敛。目录在
// 会话内变化不频繁，做 30s 短缓存，避免每次打开弹窗都拉全量目录。
let cache: { data: IndustrySubjectCatalog; expiresAt: number } | null = null;

export async function fetchIndustrySubjects(force = false): Promise<IndustrySubjectCatalog | null> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.data;
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/industry-subjects`, { headers: apiHeaders() });
    if (!response.ok) return null;
    const data = asRecord(await response.json());
    const catalog: IndustrySubjectCatalog = {
      users: asArray(data.users).map((item) => {
        const user = asRecord(item);
        return {
          id: str(user.id),
          name: str(user.displayName) || str(user.username),
          sub: str(user.org),
          kw: str(user.username),
          orgIds: asArray(user.orgIds).map(String).filter(Boolean),
        };
      }),
      roles: asArray(data.roles).map((item) => {
        const role = asRecord(item);
        return { id: str(role.id), name: str(role.name), sub: `${num(role.users)} 人` };
      }),
      orgs: asArray(data.orgs).map((item) => {
        const org = asRecord(item);
        return {
          id: str(org.id),
          name: str(org.path) || str(org.name),
          sub: str(org.name),
          path: str(org.path),
          parentId: org.parentId == null ? null : str(org.parentId),
        };
      }),
    };
    cache = { data: catalog, expiresAt: Date.now() + 30_000 };
    return catalog;
  } catch {
    return null;
  }
}
