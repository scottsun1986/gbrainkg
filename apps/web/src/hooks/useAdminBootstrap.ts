"use client";
import { useCallback, useState } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { errorMessage, apiMessage, asArray, asRecord, str, bool } from '@/lib/errors';
import { emitAdminDataUpdated } from '@/lib/app-events';
import { appStore } from '@/lib/app-store';
import type { AdminData, CurrentUser, KbInfo, OrgTreeNode, UserRow } from '@/types';

function mapKbs(raw: unknown[]): KbInfo[] {
  return raw.map((item) => {
    const kb = asRecord(item);
    const admins = asArray(kb.admins).map((a) => {
      const admin = asRecord(a);
      const user = asRecord(admin.user);
      return { n: str(user.displayName), i: str(user.username) };
    });
    return {
      id: str(kb.id),
      type: str(kb.type),
      name: str(kb.name),
      desc: str(kb.description),
      docs: Number(kb.documentCount ?? asArray(kb.docs).length ?? 0),
      canWrite: bool(kb.canWrite),
      canManage: bool(kb.canManage),
      canGrant: bool(kb.canGrant),
      canDelete: bool(kb.canDelete),
      admins,
      visibility: kb.type === 'personal' ? '仅自己' : kb.type === 'org' ? '组织继承' : '按授权',
      owner: str(asRecord(kb.ownerUser).displayName) || str(asRecord(kb.ownerUser).username) || '系统',
    };
  });
}

function mapUsers(raw: unknown[]): UserRow[] {
  return raw.map((item) => {
    const u = asRecord(item);
    const memberships = asArray(u.orgs);
    const roles = asArray(u.roles)
      .map((r) => str(asRecord(asRecord(r).role).name))
      .filter(Boolean);
    const orgNodes = memberships
      .map((m) => asRecord(m).orgNode as OrgTreeNode | undefined)
      .filter((n): n is OrgTreeNode => Boolean(n && typeof n === 'object'));
    const orgNames = orgNodes.map((node) => str(node.name)).filter(Boolean);
    const orgPaths = orgNodes.map((node) => str(node.path) || str(node.name)).filter(Boolean);
    return {
      id: str(u.id),
      name: str(u.displayName) || str(u.username),
      initials: str(u.username),
      email: str(u.email),
      t: u.source === 'manual' ? '手动创建' : (str(u.source) || '系统用户'),
      roles: roles.length ? roles : ['普通用户'],
      status: str(u.status, 'active'),
      org: orgNames.join('、') || '未分配组织',
      orgPath: orgPaths.join('、') || '—',
      orgs: orgNames,
      orgNodes,
      orgIds: orgNodes.map((node) => str(node.id)),
      canManage: bool(u.canManage),
    };
  });
}

/** Fetch admin/session bootstrap data and refresh the shared app store. */
export function useAdminBootstrap(): {
  loadAdminData: (token: string) => Promise<void>;
  currentUser: CurrentUser | null;
  setCurrentUser: (user: CurrentUser | null) => void;
  dbData: AdminData | null;
  setDbData: (data: AdminData | null) => void;
} {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [dbData, setDbData] = useState<AdminData | null>(null);

  const loadAdminData = useCallback(async (token: string) => {
    const [res, conversationsResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/v1/admin/data`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API_BASE_URL}/api/v1/conversations`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
    ]);
    let d: AdminData;
    if (res.ok) {
      d = await res.json();
    } else if (res.status === 403) {
      const sessionRes = await fetch(`${API_BASE_URL}/api/v1/session/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
      if (!sessionRes.ok) throw new Error(`API ${sessionRes.status}`);
      const session = asRecord(await sessionRes.json()) as AdminData;
      d = { ...session, kbs: session.kbs || [], users: [], orgs: [], roles: [], grants: [], providers: [], models: [], audit: [], dream: null };
    } else {
      throw new Error(`API ${res.status}`);
    }

    appStore.CAPABILITIES = Array.isArray(d.capabilities) ? (d.capabilities as string[]) : [];
    appStore.KNOWLEDGE_BASES = mapKbs(asArray(d.kbs));
    appStore.USERS = mapUsers(asArray(d.users));
    appStore.ROLES = asArray(d.roles).map((item) => {
      const role = asRecord(item);
      return {
        ...role,
        id: str(role.id),
        name: str(role.name),
        desc: str(role.description),
        perms: Array.isArray(role.permissions) ? (role.permissions as string[]) : asArray(role.perms).map(String),
        users: typeof role.users === 'number' ? role.users : 0,
        builtin: bool(role.builtin),
      };
    });
    const grants = asArray(d.grants);
    appStore.INDUSTRY_KBS = asArray(d.managedIndustryKbs)
      .filter((kb) => asRecord(kb).type === 'industry')
      .map((item) => {
        const kb = asRecord(item);
        return {
          ...kb,
          id: str(kb.id),
          name: str(kb.name),
          type: str(kb.type, 'industry'),
          desc: str(kb.description),
          docs: Number(kb.documentCount || 0),
          created: kb.createdAt ? new Date(String(kb.createdAt)).toLocaleDateString('zh-CN') : '—',
          admins: asArray(kb.admins).map((a) => {
            const user = asRecord(asRecord(a).user);
            return { n: str(user.displayName) || str(user.username), i: str(user.username) };
          }),
          grants: grants.filter((grant) => asRecord(grant).kbId === kb.id).length,
          canManage: bool(kb.canManage),
          canGrant: bool(kb.canGrant),
          canDelete: bool(kb.canDelete),
        };
      });
    appStore.GRANTS = grants.map((item) => {
      const grant = asRecord(item);
      const subject = grant.subjectType === 'user'
        ? (appStore.USERS.find((u) => u.id === grant.subjectId)?.name || str(grant.subjectId))
        : grant.subjectType === 'role'
          ? (appStore.ROLES.find((r) => r.id === grant.subjectId)?.name || str(grant.subjectId))
          : (asArray(d.orgs).find((o) => asRecord(o).id === grant.subjectId) ? str(asRecord(asArray(d.orgs).find((o) => asRecord(o).id === grant.subjectId)).name) : str(grant.subjectId));
      return {
        ...grant,
        id: str(grant.id),
        kbId: str(grant.kbId),
        subjectId: str(grant.subjectId),
        subjectType: str(grant.subjectType),
        subj: subject,
        type: str(grant.subjectType),
        exp: grant.expiresAt ? new Date(String(grant.expiresAt)).toLocaleDateString('zh-CN') : '永久',
        scope: str(grant.subjectType),
      };
    });
    appStore.PROVIDERS = asArray(d.providers).map((item) => {
      const provider = asRecord(item);
      const defaultParams = asRecord(provider.defaultParams);
      return {
        ...provider,
        id: str(provider.id),
        name: str(provider.name),
        url: str(provider.baseUrl),
        note: str(defaultParams.note),
        kind: str(provider.kind, 'external'),
      };
    });
    appStore.MODELS = { llm: [], fast_llm: [], embedding: [], rerank: [] };
    asArray(d.models).forEach((item) => {
      const model = asRecord(item);
      const rawKind = str(model.kind);
      const kind = (['llm', 'fast_llm', 'embedding', 'rerank'].includes(rawKind) ? rawKind : 'llm') as keyof typeof appStore.MODELS;
      const providerName = str(asRecord(model.provider).name, '—');
      const contextLen = Number(model.contextLen || 0);
      appStore.MODELS[kind].push({
        ...model,
        id: str(model.id),
        kind,
        name: str(model.modelName),
        provider: providerName,
        ctx: `${Math.round(contextLen / 1024) || contextLen}K`,
        dim: model.dimensions ? `${String(model.dimensions)} 维` : '',
        default: bool(model.isDefault),
        tested: model.testStatus === 'passed',
      });
    });
    appStore.AUDIT = asArray(d.audit).map((item) => {
      const row = asRecord(item);
      return {
        ...row,
        id: str(row.id),
        when: new Date(String(row.when)).toLocaleString('zh-CN'),
        what: str(row.action),
        actor: str(row.actor),
      };
    });
    appStore.AUDIT_META = (d.auditPagination as typeof appStore.AUDIT_META | null) || { page: 1, limit: 20, total: appStore.AUDIT.length, totalPages: 1 };
    appStore.DREAM = d.dream || null;
    appStore.SYSTEM_STATUS = d.systemStatus || null;
    setCurrentUser(d.user || null);
    if (asArray(d.orgs).length) {
      const nodes: OrgTreeNode[] = asArray(d.orgs).map((item) => {
        const node = asRecord(item);
        return {
          ...node,
          id: str(node.id),
          name: str(node.name),
          path: str(node.path),
          parentId: node.parentId == null ? null : str(node.parentId),
          kbs: asArray(node.kbs).map((kb) => str(asRecord(kb).id)),
          knowledgeBase: (asArray(node.kbs)[0] as OrgTreeNode['knowledgeBase']) || null,
          admins: asArray(node.admins).map((a) => str(asRecord(asRecord(a).user).displayName) || str(asRecord(asRecord(a).user).username)).filter(Boolean),
          children: [],
        };
      });
      const byId: Record<string, OrgTreeNode> = Object.fromEntries(nodes.map((node) => [node.id, node]));
      for (const node of nodes) {
        const parent = node.parentId ? byId[node.parentId] : nodes
          .filter((candidate) => candidate.id !== node.id && node.path.startsWith(`${candidate.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (parent) parent.children.push(node);
      }
      const roots = nodes.filter((node) => !nodes.some((candidate) => candidate.children.includes(node)));
      appStore.ORG_TREES = roots.map((root) => ({ ...root, expanded: true }));
      appStore.ORG_TREE = appStore.ORG_TREES[0] || null;
    } else {
      appStore.ORG_TREES = [];
      appStore.ORG_TREE = null;
    }
    appStore.CONVERSATIONS = conversationsResponse && conversationsResponse.ok
      ? await conversationsResponse.json().catch(() => [])
      : [];
    setDbData(d);
    emitAdminDataUpdated({ orgTrees: appStore.ORG_TREES, orgTree: appStore.ORG_TREE });
  }, []);

  return { loadAdminData, currentUser, setCurrentUser, dbData, setDbData };
}
