"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { asArray, asRecord, str, bool } from '@/lib/errors';
import { emitAdminDataUpdated } from '@/lib/app-events';
import { appStore } from '@/lib/app-store';
import type { AdminData, ConversationSummary, CurrentUser, KbInfo, OrgTreeNode, UserRow } from '@/types';

function mapKbs(raw: unknown[]): KbInfo[] {
  return raw.map((item) => {
    const kb = asRecord(item);
    const admins = asArray(kb.admins).map((a) => {
      const admin = asRecord(a);
      const user = asRecord(admin.user);
      return { id: str(admin.userId) || str(user.id), n: str(user.displayName), i: str(user.username) };
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
  /** Resolves with the session user (含 mustChangePassword 标记) 供刷新链路判定。 */
  loadAdminData: (token: string) => Promise<CurrentUser | null>;
  currentUser: CurrentUser | null;
  setCurrentUser: (user: CurrentUser | null) => void;
  dbData: AdminData | null;
  setDbData: (data: AdminData | null) => void;
} {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [dbData, setDbData] = useState<AdminData | null>(null);

  const loadSequence = useRef(0);
  const activeLoad = useRef<AbortController | null>(null);
  useEffect(() => () => { activeLoad.current?.abort(); }, []);

  const loadAdminData = useCallback(async (token: string): Promise<CurrentUser | null> => {
    const sequence = ++loadSequence.current;
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    const isCurrent = () => sequence === loadSequence.current && window.localStorage.getItem('llmwiki_token') === token;
    const headers = { Authorization: `Bearer ${token}` };
    const fetchData = async (path: string, timeoutMs = 15_000) => {
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) request.abort();
      const timer = window.setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(`${API_BASE_URL}${path}`, { headers, signal: request.signal });
        return { ok: response.ok, status: response.status, data: response.ok ? await response.json() : null };
      } finally {
        window.clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
      }
    };
    // 阶段一：轻量 session/bootstrap（所有用户可用）+ 会话列表并行拉取。
    // 普通用户不再先打注定 403 的 admin/data（服务端在拒绝前还要执行数个
    // 权限查询）；管理员的完整清单在阶段二异步补齐，不阻塞主壳渲染。
    const applyBootstrap = async (d: AdminData) => {
    if (!isCurrent()) return;
    appStore.CAPABILITIES = Array.isArray(d.capabilities) ? (d.capabilities as string[]) : [];
    appStore.IS_SUPER_ADMIN = asArray(asRecord(d.user).roles)
      .map((item) => str(asRecord(asRecord(item).role).name))
      .includes('超级管理员');
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
            const admin = asRecord(a);
            const user = asRecord(admin.user);
            return {
              id: str(admin.userId) || str(user.id),
              n: str(user.displayName) || str(user.username),
              i: str(user.username),
            };
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
    setDbData(d);
    emitAdminDataUpdated({ orgTrees: appStore.ORG_TREES, orgTree: appStore.ORG_TREE });
    };

    // History is independent of session readiness. A stalled history request
    // must not delay the composer, and a late response must not cross sessions.
    // Only the first page is loaded here: the sidebar fetches older pages on
    // demand, so first paint no longer carries every conversation the user ever
    // had.
    void fetchData('/api/v1/conversations?paginated=1&limit=30').then((response) => {
      if (!isCurrent()) return;
      const page = response.ok ? asRecord(response.data) : null;
      if (!page || !Array.isArray(page.items)) throw new Error('Conversation list unavailable');
      appStore.CONVERSATIONS = page.items as ConversationSummary[];
      appStore.CONVERSATIONS_META = {
        nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
        hasMore: page.hasMore === true,
      };
      emitAdminDataUpdated({ orgTrees: appStore.ORG_TREES, orgTree: appStore.ORG_TREE });
    }).catch(() => {
      if (isCurrent() && !controller.signal.aborted) window.dispatchEvent(new CustomEvent('app-toast', { detail: '会话列表加载失败，可继续提问或刷新重试' }));
    });
    const sessionRes = await fetchData('/api/v1/session/bootstrap').catch(() => null);
    if (!isCurrent()) return null;
    if (!sessionRes?.ok && sessionRes?.status !== 404 && sessionRes?.status !== 405) {
      throw Object.assign(new Error(sessionRes ? `API ${sessionRes.status}` : 'Session service unavailable'), { status: sessionRes?.status });
    }

    if (sessionRes && sessionRes.ok) {
      const session = asRecord(sessionRes.data);
      const caps: string[] = Array.isArray(session?.capabilities) ? (session!.capabilities as unknown[]).map(String) : [];
      const maybeAdmin = ['*', 'org.read', 'org.user.read', 'kb.industry.read', 'role.read', 'audit.read', 'system.settings.read']
        .some((cap) => caps.includes(cap));
      await applyBootstrap({
        ...(session as unknown as AdminData),
        users: [], orgs: [], roles: [], grants: [], providers: [], models: [], audit: [], dream: null,
      });
      if (maybeAdmin) {
        // 阶段二：管理面全量清单异步补齐（不阻塞主壳首屏）。
        void (async () => {
          const adminRes = await fetchData('/api/v1/admin/data', 30_000);
          if (!adminRes.ok) throw new Error(`API ${adminRes.status}`);
          await applyBootstrap(adminRes.data as AdminData);
        })().catch(() => {
          if (isCurrent()) window.dispatchEvent(new CustomEvent('app-toast', { detail: '管理数据加载失败，请刷新重试' }));
        });
      }
      return (asRecord(session?.user) ? (session!.user as CurrentUser) : null);
    }

    // Only an absent legacy endpoint warrants the admin fallback. Transport
    // failure or expired credentials should not trigger another expensive call.
    const res = await fetchData('/api/v1/admin/data', 30_000);
    if (!isCurrent()) return null;
    if (!res.ok) {
      const error = new Error(`API ${res.status}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    const fallback = res.data as AdminData;
    await applyBootstrap(fallback);
    return asRecord(fallback?.user) ? (fallback.user as CurrentUser) : null;
  }, []);

  return { loadAdminData, currentUser, setCurrentUser, dbData, setDbData };
}
