"use client";
import React, { useState, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitDataRefresh } from '@/lib/app-events';
import type { RoleRow } from '@/types';

export function RolesPanel({canManage = false}: { canManage?: boolean }){
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleRow | null>(null);
  const [confirmDel, setConfirmDel] = useState<RoleRow | null>(null);
  const [search, setSearch] = useState('');

  const getPermBadgeClass = (p: string) => {
    if (p === '*') return 'perm-chip all';
    if (p.startsWith('chat.') || p === 'kb.read') return 'perm-chip wb';
    if (p.startsWith('kb.industry')) return 'perm-chip kb';
    if (p.startsWith('org.') || p.startsWith('role.')) return 'perm-chip org';
    return 'perm-chip sys';
  };

  const filtered = appStore.ROLES.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.name.toLowerCase().includes(q) || (r.desc || '').toLowerCase().includes(q) || r.perms.some((p: string) => p.toLowerCase().includes(q));
  });

  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div className="h1">角色与权限矩阵</div>
          <div className="subline">角色是系统功能与数据范围的权限模板，可分配给单人或批量人员 · 内置角色受安全策略保护不可删除</div>
        </div>
        {canManage && (
          <button className="btn primary" onClick={()=>{setEditTarget(null); setOpen(true);}}>
            <Icon name="plus" size={12}/> 新增自定义角色
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <div className="admin-toolbar-left">
          <div className="search-input">
            <input placeholder="搜索角色名称 / 描述 / 权限码…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          {search && (
            <button className="btn" style={{padding:'4px 8px',fontSize:'11.5px'}} onClick={()=>setSearch('')}>
              重置
            </button>
          )}
        </div>
        <div className="toolbar-count">
          共 {filtered.length} / {appStore.ROLES.length} 个角色模板
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{width:160}}>角色名称</th>
              <th>权限码概览 (按模块分类)</th>
              <th>职责描述</th>
              <th style={{width:80,textAlign:'center'}}>绑定人员</th>
              <th style={{width:90,textAlign:'center'}}>角色类型</th>
              <th style={{width:130,textAlign:'right'}}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{textAlign:'center',padding:'40px 0',color:'var(--ink-4)'}}>
                  <div style={{marginBottom:'8px',color:'var(--ink-3)'}}><Icon name="shield" size={28}/></div>
                  <div>没有匹配的角色模板</div>
                </td>
              </tr>
            ) : filtered.map(r => (
              <tr key={r.id}>
                <td>
                  <div style={{fontWeight:600,color:'var(--ink)',fontSize:'13px'}}>{r.name}</div>
                </td>
                <td>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {r.perms.slice(0, 4).map((p: string, i: number) => (
                      <span key={i} className={getPermBadgeClass(p)}>
                        {p === '*' ? '全部特权 (*)' : p}
                      </span>
                    ))}
                    {r.perms.length > 4 && (
                      <span className="badge" style={{fontSize:'10px',padding:'1px 5px',color:'var(--ink-3)'}}>
                        +{r.perms.length - 4}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <span style={{color:'var(--ink-2)',fontSize:'12px',lineHeight:'1.5'}}>{r.desc}</span>
                </td>
                <td style={{textAlign:'center'}}>
                  <span style={{fontWeight:600,fontVariantNumeric:'tabular-nums',fontSize:'12.5px'}}>
                    {r.users || 0} 人
                  </span>
                </td>
                <td style={{textAlign:'center'}}>
                  <span className={r.builtin ? 'badge dark' : 'badge purple'} style={{fontSize:'11px',padding:'2px 7px'}}>
                    {r.builtin ? '🔒 内置' : '自定义'}
                  </span>
                </td>
                <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                  <div className="table-actions">
                    {canManage && (
                      <button className="btn" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>{setEditTarget(r); setOpen(true);}}>
                        编辑
                      </button>
                    )}
                    {canManage && !r.builtin && (
                      <button className="btn danger" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>setConfirmDel(r)}>
                        删除
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <RoleFormModal
          target={editTarget}
          onClose={()=>setOpen(false)}
          onSaved={()=>{setOpen(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title="删除自定义角色"
          msg={<>确认删除角色 <b style={{color:'var(--ink)'}}>{confirmDel.name}</b>？绑定该角色的 <b>{confirmDel.users}</b> 名人员将失去此角色赋予的所有权限。</>}
          onConfirm={async()=>{
            const response = await fetch(`${API_BASE_URL}/api/v1/admin/roles/${confirmDel.id}`,{method:'DELETE',headers:apiHeaders()});
            if(!response.ok) throw new Error('删除失败');
            window.dispatchEvent(new CustomEvent('app-data-refresh'));
          }}
          onClose={()=>setConfirmDel(null)}
        />
      )}
    </>
  );
}

export const ALL_PERMS = [
  {
    group: '💬 智能问答与工作台',
    items: [
      { code: 'chat.use', desc: '使用智能对话与问答功能' },
      { code: 'kb.read', desc: '查阅本人有权访问的知识库与知识图谱' },
    ]
  },
  {
    group: '行业知识库治理',
    items: [
      { code: 'kb.industry.read', desc: '进入行业知识库管理面板' },
      { code: 'kb.industry.create', desc: '新建行业知识库' },
      { code: 'kb.industry.manage', desc: '管理与维护所负责的行业知识库' },
      { code: 'kb.industry.grant', desc: '管理跨部门人员/角色/组织授权' },
    ]
  },
  {
    group: '组织架构与人员',
    items: [
      { code: 'org.read', desc: '查看企业组织架构树' },
      { code: 'org.node.create', desc: '在本层及下级组织创建子组织' },
      { code: 'org.user.read', desc: '查阅本层及下级组织人员名册' },
      { code: 'org.user.manage', desc: '新增、编辑、停用本层及下级组织人员' },
      { code: 'role.read', desc: '查阅角色与权限矩阵' },
      { code: 'role.manage', desc: '创建、编辑与删除自定义角色' },
    ]
  },
  {
    group: '系统配置与审计',
    items: [
      { code: 'system.settings.read', desc: '查看系统设置与基础配置' },
      { code: 'system.settings.manage', desc: '管理大模型与模型供应商参数' },
      { code: 'audit.read', desc: '查阅系统安全与编译审计日志' },
      { code: '*', desc: '超级管理员全局特权（包含系统全部功能）' },
    ]
  },
];

export function RoleFormModal({target, onClose, onSaved}: { target: RoleRow | null; onClose: () => void; onSaved?: () => void }){
  const isEdit = !!target;
  const [picked, setPicked] = useState(isEdit && target ? target.perms : []);
  const [name, setName] = useState(target?.name || '');
  const [description, setDescription] = useState(target?.desc || '');
  const [saving, setSaving] = useState(false);

  const toggle = (code: string) => {
    if(code === '*'){
      setPicked(picked.includes('*') ? [] : ['*']);
      return;
    }
    const np = picked.filter((p: string) => p !== '*');
    setPicked(np.includes(code) ? np.filter((p: string) => p !== code) : [...np, code]);
  };

  const isSuperSelected = picked.includes('*');

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/roles${isEdit ? `/${target.id}` : ''}`, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: {'Content-Type':'application/json',...apiHeaders()},
        body: JSON.stringify({name:name.trim(),description,permissions:picked})
      });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'角色已保存'}));
      onSaved?.();
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:errorMessage(error) || '保存失败'}));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `编辑角色 · ${target.name}` : '新增自定义角色'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? '保存中…' : isEdit ? '保存角色' : '创建角色'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label>角色名称<span className="req">*</span></label>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="如：合规审核专家 / 安全审计员" disabled={target?.builtin}/>
        </div>
        <div className="field">
          <label>角色类型</label>
          <input value={target?.builtin ? '🔒 系统内置（不可修改）' : '✨ 自定义角色'} disabled style={{background:'var(--surface-2)',color:'var(--ink-2)',fontWeight:500}}/>
        </div>
      </div>
      <div className="field">
        <label>职责描述</label>
        <textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="明确说明该角色的业务定位、职责范围与适用岗位群……"/>
      </div>
      <div className="field">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <label style={{margin:0}}>权限配置矩阵（已选 {picked.length} 项）</label>
          {isSuperSelected && <span className="badge dark" style={{fontSize:'10.5px'}}>已启用超级特权模式</span>}
        </div>
        <div style={{border:'1px solid var(--line)',borderRadius:8,background:'var(--surface)',maxHeight:280,overflowY:'auto',padding:'10px 14px'}}>
          {ALL_PERMS.map(g=>(
            <div key={g.group} style={{marginBottom:14,paddingBottom:10,borderBottom:'1px dashed var(--line-2)'}}>
              <div style={{fontSize:'11.5px',color:'var(--ink)',fontWeight:600,marginBottom:6,display:'flex',alignItems:'center',gap:4}}>
                {g.group}
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {g.items.map(p=>(
                  <label
                    key={p.code}
                    style={{
                      display:'flex',
                      alignItems:'flex-start',
                      gap:8,
                      padding:'4px 6px',
                      borderRadius:5,
                      cursor: (target?.builtin && p.code === '*') || (isSuperSelected && p.code !== '*') ? 'not-allowed' : 'pointer',
                      opacity: isSuperSelected && p.code !== '*' ? 0.45 : 1,
                      background: picked.includes(p.code) ? 'rgba(37,99,235,0.05)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(p.code)}
                      disabled={(target?.builtin && p.code === '*') || (isSuperSelected && p.code !== '*')}
                      onChange={()=>toggle(p.code)}
                      style={{marginTop:3,accentColor:'var(--ink)'}}
                    />
                    <div style={{flex:1}}>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <code style={{fontFamily:'SF Mono,Menlo,monospace',fontSize:'11px',fontWeight:600,color:'var(--ink)'}}>
                          {p.code}
                        </code>
                        <span style={{fontSize:'12px',color:'var(--ink-2)'}}>{p.desc}</span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
