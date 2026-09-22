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
