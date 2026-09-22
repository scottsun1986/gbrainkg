"use client";
import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { TagPicker } from '@/components/common/TagPicker';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitDataRefresh } from '@/lib/app-events';
import { flattenOrgTree, getSubtreeOrgIds, countSubtreeUsers } from '@/lib/org-utils';
import type { OrgTreeNode, RoleRow, TagItem, UserRow } from '@/types';

export function UsersOrgTreeNode({ node, depth = 0, selectedId, onSelect, expandedIds, onToggle, users }: { node: OrgTreeNode; depth?: number; selectedId?: string | null; onSelect: (n: OrgTreeNode) => void; expandedIds: Set<string>; onToggle: (id: string) => void; users: UserRow[] }) {
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const userCount = countSubtreeUsers(node, users);

  return (
    <div style={{ marginLeft: depth > 0 ? 12 : 0, display: 'flex', flexDirection: 'column' }}>
      <div
        className={`org-tree-node-item ${isSelected ? 'active' : ''}`}
        onClick={() => onSelect(node)}
        title={`${node.path || node.name} (含下属部门共 ${userCount} 人)`}
      >
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              color: 'var(--ink-3)',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
              fontSize: '9px'
            }}
          >
            ▶
          </span>
        ) : (
          <span style={{ width: 16, display: 'inline-block', textAlign: 'center', color: 'var(--ink-4)', fontSize: 10 }}>•</span>
        )}
        <Icon name="users" size={13} color={isSelected ? 'var(--ink)' : 'var(--ink-3)'} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
          {node.name}
        </span>
        <span className="node-badge">{userCount} 人</span>
      </div>

      {hasChildren && isExpanded && (
        <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px dashed var(--line)', marginLeft: 8, paddingLeft: 4 }}>
          {node.children.map((child) => (
            <UsersOrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              expandedIds={expandedIds}
              onToggle={onToggle}
              users={users}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function UsersPanel({ orgTrees = [], orgTree, orgOptions = [], canManage = false, capabilities = [] }: { orgTrees?: OrgTreeNode[]; orgTree?: OrgTreeNode | null; orgOptions?: Array<OrgTreeNode | { id: string; name: string; path: string; canManage?: boolean }>; canManage?: boolean; capabilities?: string[] }){
  const effectiveTrees = useMemo(() => {
    if (orgTrees && orgTrees.length > 0) return orgTrees;
    if (orgTree) return [orgTree];
    return [];
  }, [orgTrees, orgTree]);
  const [search, setSearch] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<any>(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [permFilter, setPermFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [confirmDel, setConfirmDel] = useState<any>(null);

  const isSysAdmin = (capabilities || []).includes('*');
  const manageableOrgOptions = useMemo(() => {
    if (isSysAdmin) return orgOptions;
    return orgOptions.filter((node: any) => node.canManage);
  }, [orgOptions, isSysAdmin]);

  // 组织树展开状态
  const [treeExpandedIds, setTreeExpandedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (n: any) => {
      if (!n) return;
      s.add(n.id);
      (n.children || []).forEach(walk);
    };
    effectiveTrees.forEach(walk);
    return s;
  });

  const toggleTreeNode = (id: string) => {
    setTreeExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 1. 获取当前选中组织及其子组织的 ID 集合
  const filterOrgIds = useMemo(() => {
    if (!selectedOrg) return null;
    return getSubtreeOrgIds(selectedOrg);
  }, [selectedOrg]);

  // 2. 多维度用户过滤
  const filteredUsers = useMemo(() => {
    return appStore.USERS.filter((u) => {
      // 组织树筛选（本层及以下组织）
      if (filterOrgIds && !(u.orgIds || []).some(id => filterOrgIds.has(id))) {
        return false;
      }
      // 关键字搜索
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchName = (u.name || '').toLowerCase().includes(q);
        const matchUsername = (u.initials || '').toLowerCase().includes(q);
        const matchEmail = (u.email || '').toLowerCase().includes(q);
        const matchOrg = (u.org || '').toLowerCase().includes(q);
        const matchOrgPath = (u.orgPath || '').toLowerCase().includes(q);
        const matchRoles = (u.roles || []).some(r => r.toLowerCase().includes(q));
        if (!matchName && !matchUsername && !matchEmail && !matchOrg && !matchOrgPath && !matchRoles) {
          return false;
        }
      }
      // 角色筛选
      if (roleFilter !== 'all' && !(u.roles || []).includes(roleFilter)) {
        return false;
      }
      // 状态筛选
      if (statusFilter !== 'all' && u.status !== statusFilter) {
        return false;
      }
      // 权限范围筛选
      if (permFilter === 'manageable' && !u.canManage) {
        return false;
      }
      if (permFilter === 'readonly' && u.canManage) {
        return false;
      }
      return true;
    });
  }, [filterOrgIds, search, roleFilter, statusFilter, permFilter]);

  // 3. 分页计算
  const totalUsers = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedUsers = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredUsers.slice(start, start + pageSize);
  }, [filteredUsers, currentPage, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [search, selectedOrg, roleFilter, statusFilter, permFilter, pageSize]);

  return (
    <>
      <div style={{ display:'flex', alignItems:'flex-start', marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <div className="h1">人员管理</div>
          <div className="subline">
            支持组织树快速穿透检索 · 组织管理员仅可管理本级及下级组织成员（跨级或上级人员仅供只读查看）
          </div>
        </div>
        {canManage && (
          <button className="btn primary" onClick={() => { setEditTarget(null); setOpen(true); }}>
            <Icon name="plus" size={12}/> 新增人员
          </button>
        )}
      </div>

      <div className="users-layout">
        {/* 左侧组织架构树导航面板 */}
        <div className="users-org-tree-panel">
          <div className="users-org-tree-head">
            <h4><Icon name="users" size={14} /> 组织架构筛选</h4>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (treeExpandedIds.size > 0) setTreeExpandedIds(new Set());
                else {
                  const s = new Set<string>();
                  const walk = (n: any) => { if (!n) return; s.add(n.id); (n.children || []).forEach(walk); };
                  effectiveTrees.forEach(walk);
                  setTreeExpandedIds(s);
                }
              }}
              style={{ fontSize: '10.5px', padding: '2px 6px', height: '22px' }}
            >
              {treeExpandedIds.size > 0 ? '折叠' : '展开'}
            </button>
          </div>

          <div className="users-org-tree-body">
            {/* 全部组织根项 */}
            <div
              className={`org-tree-node-item ${!selectedOrg ? 'active' : ''}`}
              onClick={() => setSelectedOrg(null)}
              title="查看所有组织人员"
            >
              <Icon name="users" size={13} color={!selectedOrg ? 'var(--ink)' : 'var(--ink-3)'} />
              <span style={{display:'inline-flex',alignItems:'center',gap:6,fontWeight:!selectedOrg?600:400}}><Icon name="users" size={13}/> 全部组织</span>
              <span className="node-badge">{appStore.USERS.length} 人</span>
            </div>

            {/* 组织层级树 */}
            {effectiveTrees.length > 0 ? (
              effectiveTrees.map((rootNode: any) => (
                <UsersOrgTreeNode
                  key={rootNode.id}
                  node={rootNode}
                  depth={0}
                  selectedId={selectedOrg?.id}
                  onSelect={setSelectedOrg}
                  expandedIds={treeExpandedIds}
                  onToggle={toggleTreeNode}
                  users={appStore.USERS}
                />
              ))
            ) : (
              <div style={{ padding: '20px 10px', fontSize: '11.5px', color: 'var(--ink-4)', textAlign: 'center' }}>
                暂无组织节点
              </div>
            )}
          </div>
        </div>

        {/* 右侧人员表格与多维检索区 */}
        <div className="users-table-panel">
          {/* 当前组织过滤高亮提示 */}
          {selectedOrg && (
            <div className="org-filter-pill">
              <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Icon name="folder" size={13}/> 当前组织筛选：<b>{selectedOrg.path || selectedOrg.name}</b> 及所有下属部门（共匹配 {filteredUsers.length} 人）</span>
              <button type="button" className="clear-btn" onClick={() => setSelectedOrg(null)}>
                ✕ 取消筛选
              </button>
            </div>
          )}

          {/* 综合搜索过滤工具栏 */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
            <input
              className="search-input"
              placeholder="搜索姓名 / 账号 / 邮箱 / 角色..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '240px' }}
            />
            <select
              className="filter-select"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">全部角色</option>
              {appStore.ROLES.map((r) => (
                <option key={r.id} value={r.name}>{r.name}</option>
              ))}
            </select>
            <select
              className="filter-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
            <select
              className="filter-select"
              value={permFilter}
              onChange={(e) => setPermFilter(e.target.value)}
            >
              <option value="all">全部权限范围</option>
              <option value="manageable">可管理 (本级及下级)</option>
              <option value="readonly">只读查看 (非管辖范围)</option>
            </select>
            {(search || selectedOrg || roleFilter !== 'all' || statusFilter !== 'all' || permFilter !== 'all') && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSearch('');
                  setSelectedOrg(null);
                  setRoleFilter('all');
                  setStatusFilter('all');
                  setPermFilter('all');
                }}
                style={{ fontSize: '11.5px', padding: '5px 10px' }}
              >
                重置全部
              </button>
            )}
            <div style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--ink-4)' }}>
              匹配到 {filteredUsers.length} / {appStore.USERS.length} 人
            </div>
          </div>

          {/* 表格数据展示 */}
          <div className="table-wrap" style={{ flex: 1 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '42px' }}>头像</th>
                  <th>姓名 / 账号</th>
                  <th>归属组织节点</th>
                  <th>角色 / 权限组</th>
                  <th style={{ width: '85px' }}>状态</th>
                  <th style={{ width: '85px' }}>管辖权限</th>
                  <th style={{ width: '110px', textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-4)' }}>
                      没有符合筛选条件的人员
                    </td>
                  </tr>
                ) : (
                  pagedUsers.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="avatar" style={{ background: u.canManage ? '#2563eb' : '#64748b' }}>{u.initials ? u.initials.slice(0, 2).toUpperCase() : 'U'}</div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{u.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--ink-4)' }}>@{u.initials?.toLowerCase()} · {u.email}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {(u.orgNodes || []).length > 0 ? (
                            u.orgNodes.map((node: any, i: number) => (
                              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                                <span className="badge ok" style={{ fontSize: '11px', padding: '1px 6px', width: 'fit-content' }}>
                                  {node.name}
                                </span>
                                {node.path && node.path !== node.name && (
                                  <span style={{ fontSize: '10.5px', color: 'var(--ink-4)', paddingLeft: '2px' }}>
                                    {node.path}
                                  </span>
                                )}
                              </div>
                            ))
                          ) : (u.orgs || []).length > 0 ? (
                            u.orgs.map((org: string, i: number) => (
                              <span key={i} className="badge ok" style={{ fontSize: '11px', padding: '1px 6px', width: 'fit-content' }}>
                                {org}
                              </span>
                            ))
                          ) : u.org && u.org !== '未分配组织' ? (
                            <span className="badge ok" style={{ fontSize: '11px', padding: '1px 6px', width: 'fit-content' }}>
                              {u.org}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--ink-4)', fontSize: '11.5px' }}>未分配组织</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {(u.roles || []).map((r, i) => (
                            <span key={i} className="badge" style={{ fontSize: '11px', padding: '1px 6px' }}>{r}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={`status ${u.status}`}>
                          <span className="d"/>
                          {u.status === 'active' ? '正常' : '已停用'}
                        </span>
                      </td>
                      <td>
                        {u.canManage ? (
                          <span style={{ color: '#2563eb', fontWeight: 600, fontSize: '11px' }}>✓ 可管理</span>
                        ) : (
                          <span style={{ color: 'var(--ink-4)', fontSize: '11px' }}>只读</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row-actions" style={{ justifyContent: 'flex-end', gap: '6px' }}>
                          {u.canManage ? (
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: '3px 8px', fontSize: '11.5px', height: '26px' }}
                              onClick={() => { setEditTarget(u); setOpen(true); }}
                            >
                              编辑
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: '3px 8px', fontSize: '11.5px', height: '26px', opacity: 0.5, cursor: 'not-allowed' }}
                              title="跨组织/上层人员仅支持只读查验"
                              disabled
                            >
                              只读
                            </button>
                          )}
                          {u.canManage && (
                            <button
                              type="button"
                              className="btn danger"
                              style={{ padding: '3px 8px', fontSize: '11.5px', height: '26px' }}
                              onClick={() => setConfirmDel(u)}
                            >
                              停用
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 分页控制栏 */}
          {totalUsers > 0 && (
            <div className="pagination-bar">
              <div>
                共 <span className="pagination-num">{totalUsers}</span> 人，第 {currentPage} / {totalPages} 页
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="pagination-select"
                >
                  <option value={10}>10 条 / 页</option>
                  <option value={20}>20 条 / 页</option>
                  <option value={50}>50 条 / 页</option>
                  <option value={100}>100 条 / 页</option>
                </select>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(1)}
                >
                  首页
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {open && (
        <UserFormModal
          target={editTarget}
          orgOptions={manageableOrgOptions}
          capabilities={capabilities}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            window.dispatchEvent(new CustomEvent('app-data-refresh'));
          }}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title="停用人员"
          msg={<>确认停用 <b style={{ color: 'var(--ink)' }}>{confirmDel.name}</b>（{confirmDel.initials}）？停用后该用户将无法登录系统，相关引用与历史仍将完整保留。</>}
          onConfirm={async () => {
            const response = await fetch(`${API_BASE_URL}/api/v1/admin/users/${confirmDel.id}`, {
              method: 'DELETE',
              headers: apiHeaders(),
            });
            if (!response.ok) throw new Error('停用失败');
            window.dispatchEvent(new CustomEvent('app-data-refresh'));
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </>
  );
}

export function UserFormModal({target, orgOptions = [], capabilities = [], onClose, onSaved}: { target: UserRow | null; orgOptions?: Array<OrgTreeNode | { id: string; name: string; path: string; canManage?: boolean }>; capabilities?: string[]; onClose: () => void; onSaved?: () => void }){
  const isEdit = !!target;
  const isSysAdmin = capabilities.includes('*');
  const [name, setName] = useState(target?.name || '');
  const [username, setUsername] = useState(target?.initials?.toLowerCase() || '');
  const [email, setEmail] = useState(target?.email || '');
  const [password, setPassword] = useState('');
  const [orgId, setOrgId] = useState(target?.orgIds?.[0] || (orgOptions[0]?.id || ''));
  const [status, setStatus] = useState(target?.status || 'active');
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<TagItem[]>(isEdit && target ? appStore.ROLES.filter(r=>target.roles.includes(r.name)).map(r=>({id:r.id,n:r.name,sub:`${r.users} 人`})) : []);

  const assignableRoles = useMemo(() => {
    if (isSysAdmin) return appStore.ROLES;
    return appStore.ROLES.filter(r => !r.builtin && r.name !== '超级管理员' && r.name !== '系统管理员');
  }, [isSysAdmin]);

  const save = async () => {
    if (!name.trim() || !username.trim() || (!isEdit && !orgId)) return;
    setSaving(true);
    try {
      const payload = {
        displayName: name.trim(),
        username: username.trim(),
        email: email.trim() || `${username.trim()}@local.invalid`,
        orgIds: orgId ? [orgId] : [],
        roleIds: roles.map(r => r.id),
        status,
        ...(password ? { password } : {})
      };
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/users${isEdit ? `/${target.id}` : ''}`, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '人员已保存' }));
      onSaved?.();
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(error) || '保存失败' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `编辑人员 · ${target.name}` : '新增人员'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : isEdit ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field"><label>姓名<span className="req">*</span></label><input value={name} onChange={e=>setName(e.target.value)} placeholder="如：陈昱"/></div>
        <div className="field"><label>用户名<span className="req">*</span></label><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="登录账号" disabled={isEdit}/></div>
      </div>
      <div className="field-row">
        <div className="field"><label>邮箱</label><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="user@example.com"/></div>
        <div className="field"><label>初始/重置密码</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={isEdit?'不修改请留空':'留空使用系统默认密码'}/></div>
      </div>
      <div className="field">
        <label>归属组织节点<span className="req">*</span></label>
        <select value={orgId} onChange={e=>setOrgId(e.target.value)}>
          <option value="">选择组织节点…</option>
          {orgOptions.map(node => <option key={node.id} value={node.id}>{node.path}</option>)}
        </select>
        <div className="field-hint">
          {isSysAdmin
            ? '系统管理员可为人员分配系统内任意组织节点。'
            : '组织管理员仅可选择您所管辖的本级组织及下属子组织。'}
        </div>
      </div>
      <div className="field">
        <label>绑定角色</label>
        <TagPicker
          placeholder="搜索并选择角色..."
          items={assignableRoles.map(r=>({id:r.id,n:r.name,sub:`${r.users} 人 · ${r.builtin?'内置':r.perms.length+' 权限'}`}))}
          selected={roles}
          setSelected={setRoles}
        />
        <div className="field-hint">
          {isSysAdmin
            ? '角色决定默认权限范围；额外授权可在「权限授权」单独配置。'
            : '组织管理员可为本组织人员赋予组织管理员或普通用户等角色。'}
        </div>
      </div>
      <div className="field">
        <label>状态</label>
        <select value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </div>
    </Modal>
  );
}
