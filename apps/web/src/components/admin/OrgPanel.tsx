"use client";
import React, { useState, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { TagPicker } from '@/components/common/TagPicker';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitDataRefresh, emitAdminDataUpdated } from '@/lib/app-events';
import { hasCapability } from '@/lib/capabilities';
import { flattenOrgTree, getSubtreeOrgIds, countSubtreeUsers } from '@/lib/org-utils';
import type { OrgTreeNode, TagItem, UserRow } from '@/types';

export function AddOrgModal({parent, orgOptions = [], canCreateRoot = false, onAdd, onClose}: { parent: OrgTreeNode | null; orgOptions?: Array<OrgTreeNode | { id: string; name: string; path: string; canManage?: boolean }>; canCreateRoot?: boolean; onAdd: (name: string, parentId: string | null, adminUserIds: string[]) => void | Promise<boolean | void>; onClose: () => void }){
  const [name, setName] = useState('');
  const [admins, setAdmins] = useState<TagItem[]>([]);
  const initialParentId = parent?.id || '';
  const [parentId, setParentId] = useState(initialParentId);
  const selectableParents = orgOptions.filter((option) => option.canManage || option.id === initialParentId);
  return (
    <Modal title="新增组织" onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!name.trim() || (!parentId && !canCreateRoot)} onClick={()=>onAdd(name.trim(), parentId || null, admins.map(item=>item.id))}>创建</button>
      </>
    }>
      <div className="field">
        <label>组织名称<span className="req">*</span></label>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="如：合规三组 / 华东分部" onKeyDown={e=>{if(e.key==='Enter' && name.trim() && (parentId || canCreateRoot)) onAdd(name.trim(), parentId || null, admins.map(item=>item.id));}}/>
      </div>
      <div className="field">
        <label>挂载到组织<span className="req">*</span></label>
        <select value={parentId} onChange={e=>setParentId(e.target.value)}>
          {canCreateRoot && <option value="">作为根组织</option>}
          {!canCreateRoot && <option value="" disabled>请选择可管理的上级组织</option>}
          {selectableParents.map((option) => (
            <option key={option.id} value={option.id}>{option.path}</option>
          ))}
        </select>
        <div className="field-hint">只能选择当前账号有组织管理权限的节点作为上级组织；组织管理员不能创建根组织或挂载到上级组织。</div>
      </div>
      <div className="field">
        <label>组织管理员（可选）</label>
        <TagPicker placeholder="创建时直接指定管理员..." items={appStore.USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={admins} setSelected={setAdmins}/>
        <div className="field-hint">管理员将同时成为该组织知识库管理员；上级组织管理员自动拥有本组织及下级组织的管理权限。被选人员还需具备“组织管理员”角色，角色可在人员/角色管理中配置。</div>
      </div>
      <div style={{padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.6}}>
        <b style={{color:'var(--ink)'}}>继承规则</b>：{parentId ? '新组织将挂到所选组织之下，其成员自动继承上级组织的可见范围；' : '新组织将作为组织树根节点；'}可在创建后为该组织单独设置知识库管理员。
      </div>
    </Modal>
  );
}

export function RenameOrgModal({node, onSave, onClose}: { node: OrgTreeNode; onSave: (name: string) => void | Promise<boolean | void>; onClose: () => void }){
  const [name, setName] = useState(node.name || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e?: any) => {
    if (e) e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('组织名称不能为空');
      return;
    }
    if (/[\\/]/.test(trimmed)) {
      setError('组织名称不能包含斜杠字符（/ 或 \\）');
      return;
    }
    if (trimmed.length > 120) {
      setError('组织名称长度不能超过 120 个字符');
      return;
    }
    setError('');
    setSaving(true);
    const ok = await onSave(trimmed);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal title={`重命名组织 · ${node.name}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose} disabled={saving}>取消</button>
        <button className="btn primary" disabled={saving || !name.trim() || name.trim() === node.name} onClick={handleSubmit}>
          {saving ? '保存中…' : '确认重命名'}
        </button>
      </>
    }>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>当前完整路径</label>
          <div style={{fontSize:12,color:'var(--ink-3)',background:'var(--surface-2)',padding:'6px 10px',borderRadius:6}}>
            {node.path || node.name}
          </div>
        </div>
        <div className="field">
          <label>新组织名称<span className="req">*</span></label>
          <input
            autoFocus
            value={name}
            onChange={e => { setName(e.target.value); setError(''); }}
            placeholder="请输入新组织名称"
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(e); }}
          />
          {error && <div style={{fontSize:12,color:'var(--red)',marginTop:4}}>{error}</div>}
        </div>
        <div style={{padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.6}}>
          重命名将自动同步更新该组织以及其所有子组织的物化路径（path），并自动重新对账权限范围。
        </div>
      </form>
    </Modal>
  );
}

export function DeleteOrgModal({node, onDelete, onClose}: { node: OrgTreeNode; onDelete: (node: OrgTreeNode, cascade: boolean) => void | Promise<boolean | void>; onClose: () => void }){
  const hasChildren = (node.children || []).length > 0;
  const childCount = (node.children || []).length;
  const [cascade, setCascade] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    setDeleting(true);
    const ok = await onDelete(node, cascade);
    setDeleting(false);
    if (ok) onClose();
  };

  return (
    <Modal title={`删除组织 · ${node.name}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose} disabled={deleting}>取消</button>
        <button
          className="btn danger"
          disabled={deleting || (hasChildren && !cascade)}
          onClick={handleConfirm}
        >
          {deleting ? '删除中…' : hasChildren ? '级联删除组织及子部门' : '确认删除'}
        </button>
      </>
    }>
      <div style={{marginBottom:14,lineHeight:1.6,fontSize:13,color:'var(--ink)'}}>
        确认删除组织 <b style={{color:'var(--ink)',fontWeight:600}}>「{node.name}」</b>？
      </div>
      <div style={{fontSize:12,color:'var(--ink-3)',background:'var(--surface-2)',padding:'8px 12px',borderRadius:6,marginBottom:14}}>
        <div><b>路径：</b>{node.path || node.name}</div>
        {node.kbs && node.kbs.length > 0 && <div><b>关联：</b>包含挂载的组织知识库（删除后自动置为停用）</div>}
      </div>

      {hasChildren ? (
        <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'12px 14px',marginBottom:14}}>
          <div style={{color:'#b91c1c',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
            <span>⚠️</span> 该组织包含 {childCount} 个直接下属部门
          </div>
          <div style={{fontSize:12,color:'#991b1b',marginBottom:10,lineHeight:1.5}}>
            系统默认阻止直接删除具有下属分支的父级组织。若确认整体移除该部门分支，请勾选下方级联删除选项。
          </div>
          <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:12.5,color:'#991b1b',fontWeight:500}}>
            <input
              type="checkbox"
              checked={cascade}
              onChange={e => setCascade(e.target.checked)}
            />
            确认级联删除该组织及其所有下级子部门、解除人员挂载与组织库
          </label>
        </div>
      ) : (
        <div style={{fontSize:12,color:'var(--ink-3)',lineHeight:1.5}}>
          删除后，该节点将被归档移除，绑定的人员关联与组织管理员权限将自动解除，所属知识库将停用。
        </div>
      )}
    </Modal>
  );
}

export function EditOrgModal({node, orgOptions = [], canCreateRoot = false, onSave, onClose}: { node: OrgTreeNode; orgOptions?: Array<OrgTreeNode | { id: string; name: string; path: string; canManage?: boolean }>; canCreateRoot?: boolean; onSave: (name: string, parentId: string | null) => void | Promise<boolean | void>; onClose: () => void }){
  const [name, setName] = useState(node.name || '');
  const [parentId, setParentId] = useState(node.parentId || '');
  const descendants = new Set(orgOptions.filter((option) => option.path === node.path || option.path.startsWith(`${node.path}/`)).map((option) => option.id));
  const selectableParents = orgOptions.filter((option) => !descendants.has(option.id) && (option.canManage || option.id === node.parentId));
  const canChooseRoot = canCreateRoot;
  return (
    <Modal title={`编辑组织 · ${node.name}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!name.trim() || (!parentId && !canChooseRoot)} onClick={()=>onSave(name.trim(), parentId || null)}>保存</button>
      </>
    }>
      <div className="field">
        <label>组织名称<span className="req">*</span></label>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="请输入组织名称"/>
      </div>
      <div className="field">
        <label>挂载到组织<span className="req">*</span></label>
        <select value={parentId} onChange={e=>setParentId(e.target.value)}>
          {canCreateRoot && <option value="">作为根组织</option>}
          {!canCreateRoot && !parentId && <option value="" disabled>请选择可管理的上级组织</option>}
          {selectableParents.map((option) => (
            <option key={option.id} value={option.id}>{option.path}</option>
          ))}
        </select>
        <div className="field-hint">不能选择当前组织或其下属组织作为新的上级；组织管理员只能在自己的管理范围内调整层级。</div>
      </div>
      <div style={{padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.6}}>
        修改组织名称或上级组织后，系统会同步更新该节点及全部下属组织的物化路径，并触发权限范围重新对账。
      </div>
    </Modal>
  );
}

/* 组织节点管理员设置（每一级组织都可设置；建库后自动生效） */
export function OrgAdminModal({node, onClose, onSaved}: { node: OrgTreeNode; onClose: () => void; onSaved?: () => void }){
  const pickedInit = (node.admins||[]).map(nm => appStore.USERS.find(u=>u.name===nm)).filter((u): u is UserRow => Boolean(u)).map(u=>({id:u.id,n:u.name,sub:u.org}));
  const [picked, setPicked] = useState<TagItem[]>(pickedInit);
  const hasKb = node.kbs && node.kbs.length>0;
  const save = async () => {
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/admins`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({userIds:picked.map(p=>p.id)})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) { window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '保存失败'})); return; }
    window.dispatchEvent(new CustomEvent('app-toast',{detail:'组织管理员设置已保存'})); onSaved?.();
  };
  return (
    <Modal title={`知识库管理员 · ${node.name}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save}>保存设置</button>
      </>
    }>
      {hasKb ? (
        <div style={{fontSize:12.5,color:'var(--ink-3)',marginBottom:14,lineHeight:1.55}}>
          「<b style={{color:'var(--ink)'}}>{node.name}知识库</b>」由以下管理员共同维护。<b style={{color:'var(--ink)'}}>同层及下层组织</b>的用户默认可阅读本库；管理员拥有上传 / 编辑 / 删除 / 发布权限。
        </div>
      ) : (
        <div className="warn-strip" style={{marginBottom:14}}>
          <Icon name="alert" size={12}/>
          该组织节点当前暂无知识库。管理员将绑定到组织上——在此节点创建组织库时，他们自动成为库管理员。
        </div>
      )}
      <div className="field">
        <label>管理员（{picked.length} 人）</label>
        <TagPicker placeholder="搜索并选择管理员..." items={appStore.USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={picked} setSelected={setPicked}/>
        <div className="field-hint">建议至少 2 人，避免单人离职导致知识库无人维护。任免记录进入审计日志。</div>
      </div>
      <div className="field">
        <label>可见范围预览</label>
        <div className="perm-list">
          {hasKb ? (
            <>
              <div><code>read</code>{node.name} 及全部下级组织成员（无需授权，自动继承）</div>
              <div><code>write</code>仅上列管理员</div>
              <div><code>投稿</code>下级组织成员可投稿，管理员审核后发布（P1）</div>
            </>
          ) : (
            <>
              <div><code>bind</code>管理员绑定组织节点，建库后自动生效</div>
              <div><code>read</code>上级组织的库对本组织默认可见（继承）</div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ============== Admin: 行业库授权中枢 (GrantPanel) ============== */
export function GrantPanel({kbId, setKbId}: { kbId: string; setKbId: (id: string) => void }){
  const [grantTab, setGrantTab] = useState('user');
  const [subjectId, setSubjectId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [search, setSearch] = useState('');
  const [revokingGrant, setRevokingGrant] = useState<any>(null);

  const addGrant = async () => {
    if (!kbId || !subjectId) return;
    const expiry = expiresAt ? new Date(Date.now() + Number(expiresAt) * 86400000).toISOString() : undefined;
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/grants`,{
      method:'POST',
      headers:{'Content-Type':'application/json',...apiHeaders()},
      body:JSON.stringify({kbId,subjectType:grantTab,subjectId,expiresAt:expiry})
    });
    const result = await response.json().catch(()=>({}));
    if (!response.ok) {
      window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '授权失败'}));
      return;
    }
    setSubjectId('');
    window.dispatchEvent(new CustomEvent('app-toast',{detail:'授权策略已成功签发'}));
    window.dispatchEvent(new CustomEvent('app-data-refresh'));
  };

  const currentGrants = appStore.GRANTS.filter(g => g.kbId === kbId);
  const filteredGrants = currentGrants.filter(g => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (g.subj || '').toLowerCase().includes(q) || (g.scope || '').toLowerCase().includes(q);
  });

  const selectedKbObj = appStore.INDUSTRY_KBS.find(k => k.id === kbId) || appStore.INDUSTRY_KBS[0];

  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div className="h1">行业知识库授权中枢</div>
          <div className="subline">为行业知识库配置跨部门访问策略 · 支持按「人员 / 角色 / 组织」三维矩阵授权 · 权限变更即时生效并同步大脑</div>
        </div>
      </div>

      <div className="split-layout-container">
        {/* Left: Add Grant Wizard Card */}
        <div className="split-card">
          <div className="split-card-header">
            <div className="split-card-title">
              ➕ 新建授权规则
            </div>
            <span className="badge ok" style={{fontSize:'10.5px'}}>即时生效</span>
          </div>

          <div className="field">
            <label>1️⃣ 目标行业库</label>
            <select value={kbId} onChange={e=>setKbId && setKbId(e.target.value)} style={{fontWeight:500}}>
              {appStore.INDUSTRY_KBS.map(k=>(
                <option key={k.id} value={k.id}>
                  📘 {k.name} ({k.docs} 份文档)
                </option>
              ))}
            </select>
            {selectedKbObj && (
              <div className="field-hint" style={{color:'var(--ink-3)'}}>
                {selectedKbObj.desc}
              </div>
            )}
          </div>

          <div className="field">
            <label>2️⃣ 授权主体维度</label>
            <div className="segmented-control">
              <button
                type="button"
                className={`segmented-btn ${grantTab==='user'?'active':''}`}
                onClick={()=>{ setGrantTab('user'); setSubjectId(''); }}
              >
                人员
              </button>
              <button
                type="button"
                className={`segmented-btn ${grantTab==='role'?'active':''}`}
                onClick={()=>{ setGrantTab('role'); setSubjectId(''); }}
              >
                角色
              </button>
              <button
                type="button"
                className={`segmented-btn ${grantTab==='org'?'active':''}`}
                onClick={()=>{ setGrantTab('org'); setSubjectId(''); }}
              >
                组织
              </button>
            </div>
          </div>

          <div className="field">
            <label>3️⃣ 选择具体{grantTab==='user'?'人员':grantTab==='role'?'角色':'组织'}<span className="req">*</span></label>
            <select value={subjectId} onChange={e=>setSubjectId(e.target.value)}>
              <option value="">点击检索并选择{grantTab==='user'?'人员':grantTab==='role'?'角色':'组织'}…</option>
              {grantTab==='user' && appStore.USERS.filter(u=>u.status!=='disabled').map(u=>(
                <option key={u.id} value={u.id}>
                  {String(u.name)} (@{u.initials}) · {u.org || '全公司'}
                </option>
              ))}
              {grantTab==='role' && appStore.ROLES.map(r=>(
                <option key={r.id} value={r.id}>
                  {r.name} ({r.users || 0} 人)
                </option>
              ))}
              {grantTab==='org' && flattenOrgTree(appStore.ORG_TREES.length ? appStore.ORG_TREES : appStore.ORG_TREE).map((o: any)=>(
                <option key={o.id} value={o.id}>
                  {o.path}
                </option>
              ))}
            </select>
            <div className="field-hint">
              {grantTab==='org' ? '组织授权将自动包含该节点下全部直属与递归子部门成员。' : grantTab==='role' ? '绑定该角色的所有当前及未来成员均自动获得访问权。' : '单人授权仅对该成员账号独立生效。'}
            </div>
          </div>

          <div className="field">
            <label>4️⃣ 授权有效期</label>
            <select value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}>
              <option value="">永久有效 (长期知识资产推荐)</option>
              <option value="30">30 天 (临时协作)</option>
              <option value="90">90 天 (季度专项)</option>
              <option value="365">1 年 (年度授权)</option>
            </select>
          </div>

          <button
            className="btn primary"
            disabled={!subjectId || !kbId}
            style={{width:'100%',justifyContent:'center',padding:'8px 16px',marginTop:4}}
            onClick={addGrant}
          >
            <Icon name="plus" size={12}/> 确认并签发授权规则
          </button>
        </div>

        {/* Right: Current Active Grants Table Card */}
        <div>
          <div className="admin-toolbar">
            <div className="admin-toolbar-left">
              <div className="search-input">
                <input placeholder="搜索已授权主体名称 / 所属范围…" value={search} onChange={e => setSearch(e.target.value)}/>
              </div>
              {search && (
                <button className="btn" style={{padding:'4px 8px',fontSize:'11.5px'}} onClick={()=>setSearch('')}>
                  重置
                </button>
              )}
            </div>
            <div className="toolbar-count">
              当前知识库生效授权: <b>{filteredGrants.length}</b> 条
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>授权主体</th>
                  <th style={{width:90,textAlign:'center'}}>主体类型</th>
                  <th style={{width:120}}>有效期</th>
                  <th style={{width:70,textAlign:'right'}}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredGrants.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{textAlign:'center',padding:'48px 0',color:'var(--ink-4)'}}>
                      <div style={{fontSize:'32px',marginBottom:'8px'}}>🔑</div>
                      <div style={{fontWeight:500,color:'var(--ink-3)'}}>
                        {currentGrants.length === 0 ? '该行业库当前暂无生效授权记录' : '没有匹配的授权记录'}
                      </div>
                      <div style={{fontSize:'11.5px',color:'var(--ink-4)',marginTop:4}}>
                        可在左侧表单选择人员、角色或组织为本科室添加访问权限
                      </div>
                    </td>
                  </tr>
                ) : filteredGrants.map((g,i) => (
                  <tr key={g.id || i}>
                    <td>
                      <div style={{display:'flex',alignItems:'center',gap:10}}>
                        {g.avatar ? (
                          <div className="avatar" style={{width:28,height:28,fontSize:11,background:'#2563eb',color:'#fff'}}>
                            {String(g.avatar)}
                          </div>
                        ) : (
                          <div style={{width:28,height:28,borderRadius:'50%',background:'var(--surface-2)',display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--line)'}}>
                            <Icon name={g.type==='role'?'users':'folder'} size={14} color="var(--ink-2)"/>
                          </div>
                        )}
                        <div>
                          <div style={{fontWeight:600,color:'var(--ink)',fontSize:'13px'}}>{String(g.subj)}</div>
                          <div style={{fontSize:'11.5px',color:'var(--ink-3)',marginTop:2}}>{g.scope}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{textAlign:'center'}}>
                      <span
                        className="badge"
                        style={{
                          fontSize:'11px',
                          padding:'2px 7px',
                          background: g.type==='user'?'#EFF6FF':g.type==='role'?'#F5F3FF':'#ECFDF5',
                          color: g.type==='user'?'#1D4ED8':g.type==='role'?'#6D28D9':'#047857',
                          borderColor: g.type==='user'?'#BFDBFE':g.type==='role'?'#DDD6FE':'#A7F3D0'
                        }}
                      >
                        {g.type==='user'?'人员':g.type==='role'?'角色':'组织'}
                      </span>
                    </td>
                    <td>
                      <span style={{fontSize:'12px',color:g.exp==='永久'?'var(--success)':'var(--ink-2)',fontWeight:g.exp==='永久'?500:400}}>
                        {g.exp === '永久' ? '♾️ 永久有效' : `至 ${g.exp}`}
                      </span>
                    </td>
                    <td style={{textAlign:'right'}}>
                      <button
                        className="btn danger"
                        style={{padding:'3px 8px',fontSize:'11.5px'}}
                        onClick={()=>setRevokingGrant(g)}
                      >
                        撤销
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {revokingGrant && (
        <ConfirmModal
          title="撤销知识库授权"
          msg={
            <>
              确认撤销 <b>【{revokingGrant.subj}】</b> 对 <b>【{selectedKbObj?.name || '当前行业库'}】</b> 的访问权限？
              撤销后，该主体对应的人员在大脑问答与检索中将不再能访问本库知识。
            </>
          }
          onConfirm={async()=>{
            const response = await fetch(`${API_BASE_URL}/api/v1/admin/grants/${revokingGrant.id}`,{
              method:'DELETE',
              headers:apiHeaders()
            });
            if (!response.ok) throw new Error('撤销失败');
            window.dispatchEvent(new CustomEvent('app-toast',{detail:'授权已撤销'}));
            window.dispatchEvent(new CustomEvent('app-data-refresh'));
          }}
          onClose={()=>setRevokingGrant(null)}
        />
      )}
    </>
  );
}

/* ============== Admin: 组织架构全景 (OrgPanel) ============== */
export function OrgPanel({
  orgTrees = [],
  orgTree,
  expandedIds,
  onToggle,
  setExpandedIds,
  onAddChild,
  onSetAdmin,
  onRename,
  onEdit,
  onDelete,
  onActivateKb,
  onDeactivateKb,
  onManageKb,
  canCreateRoot = false
}: any){
  const trees = useMemo(() => {
    if (orgTrees && orgTrees.length > 0) return orgTrees;
    if (orgTree) return [orgTree];
    return [];
  }, [orgTrees, orgTree]);

  const [selectedNodeId, setSelectedNodeId] = useState<string>(() => trees[0]?.id || '');
  const [nodeSearch, setNodeSearch] = useState('');

  // 递归查找选中节点
  const findNode = (n: any, id: string): any => {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of (n.children || [])) {
      const found = findNode(c, id);
      if (found) return found;
    }
    return null;
  };

  const selectedNode = useMemo(() => {
    for (const root of trees) {
      const found = findNode(root, selectedNodeId);
      if (found) return found;
    }
    return trees[0] || null;
  }, [trees, selectedNodeId]);

  const flatNodes = useMemo(() => flattenOrgTree(trees), [trees]);
  const subtreeUserCount = useMemo(() => selectedNode ? countSubtreeUsers(selectedNode, appStore.USERS) : 0, [selectedNode]);
  const directUsers = useMemo(() => selectedNode ? appStore.USERS.filter((u: any) => (u.orgNodes || []).some((on: any) => on.id === selectedNode.id) || (u.orgIds || []).includes(selectedNode.id)) : [], [selectedNode]);

  const expandAll = () => {
    const s = new Set<string>();
    const walk = (n: any) => { if (!n) return; s.add(n.id); (n.children || []).forEach(walk); };
    trees.forEach(walk);
    setExpandedIds(s);
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div className="h1">组织架构拓扑</div>
          <div className="subline">维护企业多级组织树拓扑 · 支持各级独立挂载部门知识库与指定部门知识管理员</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn" onClick={expandAll}>⤢ 展开全部</button>
          <button className="btn" onClick={collapseAll}>⤡ 折叠全部</button>
          {canCreateRoot && (
            <button className="btn primary" onClick={()=>onAddChild({id:null,name:'根组织'})}>
              <Icon name="plus" size={12}/> 新增组织
            </button>
          )}
        </div>
      </div>

      <div className="split-layout-container">
        {/* Left: Interactive Tree Card */}
        <div className="split-card" style={{padding:'16px'}}>
          <div className="split-card-header">
            <div className="split-card-title" style={{display:'flex',alignItems:'center',gap:6}}>
              <Icon name="share" size={13}/> 组织拓扑树
            </div>
            <span style={{fontSize:'11.5px',color:'var(--ink-3)'}}>共 {flatNodes.length} 个节点</span>
          </div>

          <div style={{marginBottom:10}}>
            <div className="search-input" style={{maxWidth:'100%'}}>
              <input placeholder="快速筛选组织节点…" value={nodeSearch} onChange={e=>setNodeSearch(e.target.value)}/>
            </div>
          </div>

          <div className="org-tree-box">
            {trees.length > 0 ? (
              trees.map((rootNode: any) => (
                <OrgTreeItem
                  key={rootNode.id}
                  node={rootNode}
                  depth={0}
                  expandedIds={expandedIds}
                  selectedNodeId={selectedNode?.id || selectedNodeId}
                  onSelect={(id: string)=>setSelectedNodeId(id)}
                  onToggle={onToggle}
                  onAddChild={onAddChild}
                  onSetAdmin={onSetAdmin}
                  onRename={onRename}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  search={nodeSearch}
                />
              ))
            ) : (
              <div style={{padding:24,color:'var(--ink-4)',textAlign:'center'}}>暂无组织节点，请点击右上角「新增组织」创建根组织</div>
            )}
          </div>
        </div>

        {/* Right: Selected Node Profile Card */}
        {selectedNode ? (
          <div className="split-card">
            <div className="split-card-header">
              <div style={{minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:9}}>
                  <span style={{width:30,height:30,borderRadius:8,display:'inline-flex',alignItems:'center',justifyContent:'center',background:'var(--evidence-soft)',color:'var(--evidence)',flex:'0 0 auto'}}><Icon name="users" size={16}/></span>
                  <div style={{fontSize:'16px',fontWeight:600,color:'var(--ink)'}}>{selectedNode.name}</div>
                  {selectedNode.kbs && selectedNode.kbs.length > 0 ? (
                    <span className="badge ok" style={{fontSize:'11px'}}>部门库已激活</span>
                  ) : (
                    <span className="badge" style={{fontSize:'11px'}}>未激活部门库</span>
                  )}
                </div>
                <div style={{fontSize:'11.5px',color:'var(--ink-3)',marginTop:4}}>
                  全路径：{selectedNode.path || selectedNode.name}
                </div>
              </div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {selectedNode.canCreateChild && (
                  <button className="btn primary" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onAddChild(selectedNode)}>
                    <Icon name="plus" size={12}/> 添加子组织
                  </button>
                )}
                {selectedNode.canManage && (
                  <>
                    <button className="btn" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onRename?.(selectedNode)}>
                      <Icon name="edit" size={12}/> 重命名组织
                    </button>
                    <button className="btn" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onEdit?.(selectedNode)}>
                      调整层级
                    </button>
                    <button className="btn danger" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onDelete?.(selectedNode)}>
                      <Icon name="trash" size={12}/> 删除组织
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* KPI Metrics */}
            <div className="org-kpi-grid">
              <div className="org-kpi-box">
                <div className="kpi-label"><Icon name="users" size={12}/> 组织穿透总人数</div>
                <div className="kpi-val">{subtreeUserCount} <span style={{fontSize:'12px',fontWeight:400,color:'var(--ink-3)'}}>人 (直属 {directUsers.length} 人)</span></div>
              </div>
              <div className="org-kpi-box">
                <div className="kpi-label"><Icon name="folder" size={12}/> 下级子部门数</div>
                <div className="kpi-val">{selectedNode.children?.length || 0} <span style={{fontSize:'12px',fontWeight:400,color:'var(--ink-3)'}}>个下属分支</span></div>
              </div>
            </div>

            {/* Department Knowledge Base Section */}
            <div style={{background:'var(--surface-2)',border:'1px solid var(--line-2)',borderRadius:8,padding:'14px 16px',marginBottom:16}}>
              <div style={{fontSize:'13px',fontWeight:600,color:'var(--ink)',marginBottom:6,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Icon name="book" size={13}/> 组织知识库</span>
                {selectedNode.knowledgeBase && (
                  <span style={{fontSize:'11px',color:'var(--ink-3)'}}>
                    文档数：{selectedNode.knowledgeBase.docCount || 0} 篇
                  </span>
                )}
              </div>
              {selectedNode.kbs && selectedNode.kbs.length > 0 ? (
                <div>
                  <div style={{fontSize:'12px',color:'var(--ink-2)',marginBottom:10,lineHeight:'1.5'}}>
                    已为「{selectedNode.name}」启用专属组织知识库。同层及所有下属子部门成员均自动继承查阅权限。
                  </div>
                  <div style={{display:'flex',gap:8}}>
                    {selectedNode.canManage && (
                      <>
                        <button className="btn primary" style={{fontSize:'12px'}} onClick={()=>onManageKb?.(selectedNode.knowledgeBase?.id)}>
                          管理知识库文档
                        </button>
                        <button className="btn danger" style={{fontSize:'12px'}} onClick={()=>onDeactivateKb?.(selectedNode)}>
                          去激活组织库
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{fontSize:'12px',color:'var(--ink-3)',marginBottom:10}}>
                    当前节点尚未创建专属组织知识库。创建后该部门及下属成员可在此共享内部文档与制度。
                  </div>
                  {selectedNode.canManage && (
                    <button className="btn primary" style={{fontSize:'12px'}} onClick={()=>onActivateKb?.(selectedNode)}>
                      <Icon name="plus" size={12}/> 激活组织知识库
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Department Admins Section */}
            <div style={{background:'var(--surface)',border:'1px solid var(--line)',borderRadius:8,padding:'14px 16px',marginBottom:16}}>
              <div style={{fontSize:'13px',fontWeight:600,color:'var(--ink)',marginBottom:10,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Icon name="shield" size={13}/> 组织知识库管理员团队</span>
                {selectedNode.canSetAdmin && (
                  <button className="btn" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>onSetAdmin(selectedNode)}>
                    设置管理员
                  </button>
                )}
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                {(selectedNode.admins || []).length > 0 ? (
                  selectedNode.admins.map((nm: string, i: number) => {
                    const u = appStore.USERS.find((user: any) => user.name === nm);
                    return (
                      <div key={i} style={{display:'flex',alignItems:'center',gap:6,background:'var(--surface-2)',border:'1px solid var(--line-2)',padding:'4px 10px',borderRadius:6}}>
                        <div className="avatar" style={{width:22,height:22,fontSize:10,background:'#2563eb',color:'#fff'}}>
                          {(u?.initials || nm).slice(0, 2).toUpperCase()}
                        </div>
                        <span style={{fontSize:'12px',fontWeight:500,color:'var(--ink)'}}>{nm}</span>
                        {u?.org && <span style={{fontSize:'11px',color:'var(--ink-4)'}}>({u.org})</span>}
                      </div>
                    );
                  })
                ) : (
                  <div style={{fontSize:'12px',color:'var(--ink-4)',fontStyle:'italic'}}>
                    尚未指派管理员（将继承上级组织的管理策略）
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="split-card" style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'60px 20px',color:'var(--ink-4)'}}>
            请在左侧选择一个组织节点查看画像
          </div>
        )}
      </div>
    </>
  );
}

export function OrgTreeItem({node, depth, expandedIds, selectedNodeId, onSelect, onToggle, onAddChild, onSetAdmin, onRename, onEdit, onDelete, search}: { node: OrgTreeNode; depth: number; expandedIds: Set<string>; selectedNodeId: string | null; onSelect: (id: string) => void; onToggle: (id: string) => void; onAddChild: (n: OrgTreeNode) => void; onSetAdmin: (n: OrgTreeNode) => void; onRename: (n: OrgTreeNode) => void; onEdit: (n: OrgTreeNode) => void; onDelete: (n: OrgTreeNode) => void; search: string }){
  const open = expandedIds.has(node.id);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedNodeId === node.id;
  const isMatch = !search || node.name.toLowerCase().includes(search.toLowerCase());

  return (
    <div style={{display: isMatch ? 'block' : 'none'}}>
      <div
        className={`org-node-row ${isSelected ? 'active' : ''}`}
        style={{paddingLeft: `${8 + depth * 14}px`}}
        onClick={() => {
          onSelect(node.id);
        }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:16,height:16,cursor:'pointer'}}
          >
            <Icon name="chevron" size={11} className={`ic ${open ? 'open' : ''}`}/>
          </span>
        ) : (
          <span style={{width:16,display:'inline-block'}}/>
        )}
        <span style={{fontSize:'13px',marginRight:4,color:'var(--ink-3)',display:'inline-flex',verticalAlign:'middle'}}>
          {depth === 0 ? <Icon name="users" size={13}/> : hasChildren ? <Icon name="folder" size={13}/> : <Icon name="file" size={13}/>}
        </span>
        <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {node.name}
        </span>
        {node.kbs && node.kbs.length > 0 && (
          <span className="badge ok" style={{fontSize:'9.5px',padding:'0 4px'}}>库</span>
        )}
        <span style={{fontSize:'11px',color:'var(--ink-4)',fontVariantNumeric:'tabular-nums'}}>
          {node.children?.length ? `${node.children.length}` : ''}
        </span>
        {node.canManage && (
          <div className="org-node-actions" onClick={e=>e.stopPropagation()}>
            {node.canCreateChild && (
              <button
                className="org-node-action-btn"
                title="添加子组织"
                onClick={(e) => { e.stopPropagation(); onAddChild(node); }}
              >
                +
              </button>
            )}
            <button
              className="org-node-action-btn"
              title="重命名组织"
              onClick={(e) => { e.stopPropagation(); if (onRename) onRename(node); else onEdit(node); }}
            >
              ✎
            </button>
            <button
              className="org-node-action-btn danger"
              title="删除组织"
              onClick={(e) => { e.stopPropagation(); onDelete(node); }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {open && hasChildren && (
        <div style={{borderLeft:'1px dashed var(--line-2)',marginLeft:`${15 + depth * 14}px`}}>
          {node.children.map((c: any, i: number) => (
            <OrgTreeItem
              key={c.id || i}
              node={c}
              depth={depth + 1}
              expandedIds={expandedIds}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onSetAdmin={onSetAdmin}
              onRename={onRename}
              onEdit={onEdit}
              onDelete={onDelete}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  );
}

