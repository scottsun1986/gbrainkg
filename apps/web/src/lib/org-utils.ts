/** Pure helpers for walking organisation trees. */

export interface OrgTreeLike {
  id?: string;
  name?: string;
  path?: string;
  canManage?: boolean;
  parentId?: string | null;
  children?: OrgTreeLike[] | null;
  [key: string]: unknown;
}

export interface OrgUserLike {
  id?: string;
  orgIds?: string[] | null;
  [key: string]: unknown;
}

export interface FlatOrgNode {
  id: string;
  name: string;
  path: string;
  canManage: boolean;
}

function asNodes(input: OrgTreeLike | OrgTreeLike[] | null | undefined): OrgTreeLike[] {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}

export function flattenOrgTree(
  nodeOrNodes: OrgTreeLike | OrgTreeLike[] | null | undefined,
  parentPath = '',
): FlatOrgNode[] {
  if (!nodeOrNodes) return [];
  if (Array.isArray(nodeOrNodes)) {
    return nodeOrNodes.flatMap((child) => flattenOrgTree(child, parentPath));
  }
  const path = parentPath ? `${parentPath} / ${nodeOrNodes.name}` : String(nodeOrNodes.name ?? '');
  return [
    { id: String(nodeOrNodes.id ?? ''), name: String(nodeOrNodes.name ?? ''), path, canManage: Boolean(nodeOrNodes.canManage) },
    ...(nodeOrNodes.children || []).flatMap((child: OrgTreeLike) => flattenOrgTree(child, path)),
  ];
}

export interface FlatOrgNodeWithParent extends FlatOrgNode {
  parentId: string | null;
}

/** Flatten an org tree while preserving each node's parentId (for hierarchy-aware pickers). */
export function flattenOrgTreeWithParent(
  nodeOrNodes: OrgTreeLike | OrgTreeLike[] | null | undefined,
  parentId: string | null = null,
): FlatOrgNodeWithParent[] {
  if (!nodeOrNodes) return [];
  if (Array.isArray(nodeOrNodes)) {
    return nodeOrNodes.flatMap((node) => flattenOrgTreeWithParent(node, parentId));
  }
  const id = String(nodeOrNodes.id ?? '');
  return [
    {
      id,
      name: String(nodeOrNodes.name ?? ''),
      path: String(nodeOrNodes.path ?? nodeOrNodes.name ?? ''),
      canManage: Boolean(nodeOrNodes.canManage),
      parentId: nodeOrNodes.parentId ?? parentId,
    },
    ...(nodeOrNodes.children || []).flatMap((child) => flattenOrgTreeWithParent(child, id)),
  ];
}

/** Recursively collect node ids of a subtree (including the node itself). */
export function getSubtreeOrgIds(
  nodeOrNodes: OrgTreeLike | OrgTreeLike[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  const walk = (n: OrgTreeLike | OrgTreeLike[] | null | undefined) => {
    if (!n) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n.id) ids.add(String(n.id));
    (n.children || []).forEach(walk);
  };
  walk(nodeOrNodes);
  return ids;
}

/** Recursively count users belonging to a subtree. */
export function countSubtreeUsers(
  node: OrgTreeLike | null | undefined,
  users: OrgUserLike[],
): number {
  const ids = getSubtreeOrgIds(node);
  return users.filter((u) => (u.orgIds || []).some((id) => ids.has(String(id)))).length;
}

/**
 * 一次性预计算每个组织节点的子树用户数（去重口径与 countSubtreeUsers 一致）。
 * 逐节点调用 countSubtreeUsers 是 O(N×M)（每个节点都对全量用户 filter），
 * 大组织树下管理面板每次渲染重算全部节点会明显卡顿；此函数自底向上合并
 * 子树用户集合（同一用户归属多个子组织时只计一次），渲染期 O(1) 查表。
 */
export function buildSubtreeUserCounts(
  roots: Array<OrgTreeLike | null | undefined>,
  users: OrgUserLike[],
): Map<string, number> {
  const directUsers = new Map<string, Set<OrgUserLike>>();
  for (const user of users) {
    for (const orgId of user.orgIds || []) {
      const key = String(orgId);
      let bucket = directUsers.get(key);
      if (!bucket) directUsers.set(key, (bucket = new Set<OrgUserLike>()));
      bucket.add(user);
    }
  }
  const counts = new Map<string, number>();
  const visit = (node: OrgTreeLike): Set<OrgUserLike> => {
    const merged = new Set<OrgUserLike>(directUsers.get(String(node.id)) || []);
    for (const child of node.children || []) {
      for (const user of visit(child)) merged.add(user);
    }
    counts.set(String(node.id), merged.size);
    return merged;
  };
  roots.forEach((root) => root && visit(root));
  return counts;
}
