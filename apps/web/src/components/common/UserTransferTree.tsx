"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 穿梭树（dual-list transfer with org hierarchy）用户选择器。
 *
 * 用于所有“选择用户”的授权场景，替代简单下拉框：
 * - 左栏“可选人员”按**真实组织层级**呈现为可收缩的组织树，人员挂在其所属组织节点下；
 * - 支持组织级全选（含半选态）、搜索（搜索时平铺匹配结果）；
 * - 右栏“已选人员”即待提交集合，支持批量移除与清空；
 * - 移动按钮仅在存在有效选择时可用，搜索只过滤当前栏、不清除已选。
 */
export interface TransferUser {
  id: string;
  name: string;
  org?: string;
  kw?: string;
  /** 所属组织节点 id 列表（用于挂到组织树上）。 */
  orgIds?: string[];
}

export interface TransferOrg {
  id: string;
  name: string;
  parentId?: string | null;
}

interface UserTransferTreeProps {
  users: TransferUser[];
  /** 组织节点（含 parentId），用于还原组织层级树；缺省时退化为按组织名分组。 */
  orgs?: TransferOrg[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  height?: number;
  leftTitle?: string;
  rightTitle?: string;
  emptyHint?: string;
}

const UNGROUPED = '未分配组织';
const UNASSIGNED_ID = '__unassigned__';

export function matchesUserQuery(user: TransferUser, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [user.name, user.org, user.kw, user.id].some((value) => String(value || '').toLowerCase().includes(q));
}

/** 无层级信息时的兜底：按组织名分组（空组织归入“未分配组织”），组名按中文排序。 */
export function groupUsersByOrg(users: TransferUser[]): Array<[string, TransferUser[]]> {
  const groups = new Map<string, TransferUser[]>();
  for (const user of users) {
    const key = user.org && user.org.trim() ? user.org : UNGROUPED;
    const bucket = groups.get(key) ?? [];
    bucket.push(user);
    groups.set(key, bucket);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
}

/** 由扁平组织列表构建父子索引（父节点缺失者视为根）。 */
export function buildOrgTree(orgs: TransferOrg[]) {
  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const childrenByParent = new Map<string, TransferOrg[]>();
  const roots: TransferOrg[] = [];
  for (const org of orgs) {
    if (org.parentId && orgById.has(org.parentId)) {
      const bucket = childrenByParent.get(org.parentId) ?? [];
      bucket.push(org);
      childrenByParent.set(org.parentId, bucket);
    } else {
      roots.push(org);
    }
  }
  const sortNodes = (nodes: TransferOrg[]) => nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  sortNodes(roots);
  childrenByParent.forEach(sortNodes);
  return { orgById, childrenByParent, roots };
}

function Checkbox({ checked, indeterminate, onChange, title }: { checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} title={title} style={{ flex: '0 0 auto', cursor: 'pointer' }} />;
}

export function UserTransferTree({ users, orgs, selectedIds, onChange, height = 360, leftTitle = '可选人员', rightTitle = '已选人员', emptyHint }: UserTransferTreeProps) {
  const [leftQuery, setLeftQuery] = useState('');
  const [rightQuery, setRightQuery] = useState('');
  const [leftChecked, setLeftChecked] = useState<Set<string>>(new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const hierarchy = useMemo(() => (orgs && orgs.length ? buildOrgTree(orgs) : null), [orgs]);

  // 组织 -> 直属成员（无有效组织归属者归入“未分配组织”虚拟节点）
  const directMembers = useMemo(() => {
    const map = new Map<string, TransferUser[]>();
    if (!hierarchy) return map;
    for (const user of users) {
      const memberships = (user.orgIds || []).filter((id) => hierarchy.orgById.has(id));
      const targets = memberships.length ? memberships : [UNASSIGNED_ID];
      for (const orgId of targets) {
        const bucket = map.get(orgId) ?? [];
        bucket.push(user);
        map.set(orgId, bucket);
      }
    }
    return map;
  }, [users, hierarchy]);

  const subtreeIds = useMemo(() => {
    const cache = new Map<string, string[]>();
    if (!hierarchy) return cache;
    const collect = (orgId: string): string[] => {
      const cached = cache.get(orgId);
      if (cached) return cached;
      const ids = (directMembers.get(orgId) || []).map((u) => u.id);
      for (const child of hierarchy.childrenByParent.get(orgId) || []) ids.push(...collect(child.id));
      cache.set(orgId, ids);
      return ids;
    };
    hierarchy.roots.forEach((root) => collect(root.id));
    if (directMembers.has(UNASSIGNED_ID)) collect(UNASSIGNED_ID);
    return cache;
  }, [directMembers, hierarchy]);

  const available = useMemo(
    () => users.filter((u) => !selectedSet.has(u.id) && matchesUserQuery(u, leftQuery)),
    [users, selectedSet, leftQuery],
  );
  const selected = useMemo(
    () => users.filter((u) => selectedSet.has(u.id) && matchesUserQuery(u, rightQuery)),
    [users, selectedSet, rightQuery],
  );

  const toggleIn = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const toggleStage = (ids: string[]) => {
    if (!ids.length) return;
    setLeftChecked((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const moveRight = () => {
    if (!leftChecked.size) return;
    const next = new Set(selectedIds);
    leftChecked.forEach((id) => { if (usersById.has(id)) next.add(id); });
    onChange([...next]);
    setLeftChecked(new Set());
  };
  const moveAllRight = () => {
    if (!available.length) return;
    const next = new Set(selectedIds);
    available.forEach((u) => next.add(u.id));
    onChange([...next]);
    setLeftChecked(new Set());
  };
  const moveLeft = () => {
    if (!rightChecked.size) return;
    onChange(selectedIds.filter((id) => !rightChecked.has(id)));
    setRightChecked(new Set());
  };
  const moveAllLeft = () => {
    if (!selected.length) return;
    const keep = new Set(selected.map((u) => u.id));
    onChange(selectedIds.filter((id) => !keep.has(id)));
    setRightChecked(new Set());
  };

  const renderUserRow = (user: TransferUser, depth: number) => (
    <label key={user.id} className="ut-row" style={{ paddingLeft: 10 + depth * 16 }}>
      <Checkbox checked={leftChecked.has(user.id)} onChange={() => setLeftChecked((prev) => toggleIn(prev, user.id))} />
      <span className="ut-name">{user.name}</span>
      {user.kw ? <span className="ut-meta">{user.kw}</span> : null}
    </label>
  );

  const renderOrgNode = (org: TransferOrg, depth: number): React.ReactNode => {
    const ids = subtreeIds.get(org.id) || [];
    const checkedCount = ids.filter((id) => leftChecked.has(id)).length;
    const isCollapsed = collapsed.has(org.id);
    const children = hierarchy?.childrenByParent.get(org.id) || [];
    const members = directMembers.get(org.id) || [];
    const hasChildrenContent = children.length > 0 || members.length > 0;
    return (
      <div key={org.id}>
        <div className="ut-org-head" style={{ paddingLeft: 8 + depth * 16 }}>
          <button type="button" className="ut-caret" onClick={() => setCollapsed((prev) => toggleIn(prev, org.id))} aria-label={isCollapsed ? '展开' : '折叠'}>
            {hasChildrenContent ? (isCollapsed ? '▸' : '▾') : '·'}
          </button>
          <Checkbox
            checked={ids.length > 0 && checkedCount === ids.length}
            indeterminate={checkedCount > 0 && checkedCount < ids.length}
            onChange={() => toggleStage(ids)}
            title="全选本组织及下级成员"
          />
          <span className="ut-org-name" onClick={() => setCollapsed((prev) => toggleIn(prev, org.id))}>{org.name}</span>
          <span className="ut-count">{ids.length}</span>
        </div>
        {!isCollapsed && (
          <>
            {children.map((child) => renderOrgNode(child, depth + 1))}
            {members.map((user) => renderUserRow(user, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderFlatGroups = (list: TransferUser[]) => {
    const groups = groupUsersByOrg(list);
    if (!groups.length) return <div className="ut-empty">{emptyHint || '没有匹配的可选人员'}</div>;
    return groups.map(([group, members]) => {
      const isCollapsed = collapsed.has(group);
      const checkedCount = members.filter((m) => leftChecked.has(m.id)).length;
      return (
        <div key={group} className="ut-group">
          <div className="ut-group-head">
            <button type="button" className="ut-caret" onClick={() => setCollapsed((prev) => toggleIn(prev, group))} aria-label={isCollapsed ? '展开' : '折叠'}>
              {isCollapsed ? '▸' : '▾'}
            </button>
            <Checkbox
              checked={members.length > 0 && checkedCount === members.length}
              indeterminate={checkedCount > 0 && checkedCount < members.length}
              onChange={() => {
                const next = new Set(leftChecked);
                const all = checkedCount === members.length;
                members.forEach((m) => (all ? next.delete(m.id) : next.add(m.id)));
                setLeftChecked(next);
              }}
              title="全选本组"
            />
            <span className="ut-group-name" onClick={() => setCollapsed((prev) => toggleIn(prev, group))}>{group}</span>
            <span className="ut-count">{members.length}</span>
          </div>
          {!isCollapsed && members.map((user) => renderUserRow(user, 1))}
        </div>
      );
    });
  };

  const renderAvailable = () => {
    if (!available.length) return <div className="ut-empty">{emptyHint || '没有匹配的可选人员'}</div>;
    // 搜索时平铺结果，便于快速定位；否则按组织层级树展示。
    if (leftQuery.trim() || !hierarchy) return renderFlatGroups(available);
    return (
      <>
        {hierarchy.roots.map((root) => renderOrgNode(root, 0))}
        {directMembers.has(UNASSIGNED_ID) && renderOrgNode({ id: UNASSIGNED_ID, name: UNGROUPED, parentId: null }, 0)}
      </>
    );
  };

  const renderSelected = () => {
    if (!selected.length) return <div className="ut-empty">尚未选择人员</div>;
    return selected.map((user) => (
      <label key={user.id} className="ut-row" style={{ paddingLeft: 10 }}>
        <Checkbox checked={rightChecked.has(user.id)} onChange={() => setRightChecked((prev) => toggleIn(prev, user.id))} />
        <span className="ut-name">{user.name}</span>
        {user.org ? <span className="ut-meta">{user.org}</span> : null}
      </label>
    ));
  };

  return (
    <div className="ut-root">
      <div className="ut-panes">
        <div className="ut-pane">
          <div className="ut-pane-head">
            <span>{leftTitle}</span>
            <span className="ut-count">可用 {available.length}</span>
          </div>
          <div className="search-input ut-search">
            <input placeholder="搜索姓名 / 组织 / 账号…" value={leftQuery} onChange={(e) => setLeftQuery(e.target.value)} />
          </div>
          <div className="ut-list" style={{ maxHeight: height }}>
            {renderAvailable()}
          </div>
        </div>

        <div className="ut-actions">
          <button type="button" className="btn primary" disabled={!leftChecked.size} onClick={moveRight} title="添加所选到已选">→</button>
          <button type="button" className="btn" disabled={!available.length} onClick={moveAllRight} title="全部添加">⇉</button>
          <button type="button" className="btn" disabled={!rightChecked.size} onClick={moveLeft} title="移回可选">←</button>
          <button type="button" className="btn" disabled={!selected.length} onClick={moveAllLeft} title="清空已选">⇇</button>
        </div>

        <div className="ut-pane">
          <div className="ut-pane-head">
            <span>{rightTitle}</span>
            <span className="ut-count">已选 {selected.length}</span>
          </div>
          <div className="search-input ut-search">
            <input placeholder="搜索已选人员…" value={rightQuery} onChange={(e) => setRightQuery(e.target.value)} />
          </div>
          <div className="ut-list" style={{ maxHeight: height }}>
            {renderSelected()}
          </div>
        </div>
      </div>
      <div className="ut-footer">共选择 <b>{selectedIds.length}</b> 人</div>
    </div>
  );
}
