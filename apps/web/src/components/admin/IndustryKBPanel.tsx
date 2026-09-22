"use client";
import React, { useState, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { TagPicker } from '@/components/common/TagPicker';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitDataRefresh } from '@/lib/app-events';
import type { IndustryKbRow, TagItem, UserRow } from '@/types';

export function TextKnowledgeModal({onClose, onSave}: { onClose: () => void; onSave: (payload: { title: string; content: string }) => void }){
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    try { await onSave({title: title.trim(), content: content.trim()}); }
    finally { setSaving(false); }
  };
  return <Modal title="添加文本知识" onClose={onClose} foot={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!content.trim() || saving} onClick={save}>{saving?'保存中…':'保存并索引'}</button></>}>
    <div className="field"><label>标题（可选）</label><input value={title} onChange={e=>setTitle(e.target.value)} placeholder="不填写则显示为“未命名文本知识”" maxLength={200}/></div>
    <div className="field"><label>内容<span className="req">*</span></label><textarea value={content} onChange={e=>setContent(e.target.value)} placeholder="记录制度、经验、账号备注等文本知识……" style={{minHeight:220}} maxLength={10000000}/></div>
    <div className="field-hint">内容会经过统一解析、分块、向量化和百纳索引，保存后即可用于问答。</div>
  </Modal>;
}

/* ============== Admin: 行业库管理（含动态新增） ============== */
export function IndustryKBPanel({onOpenGrant, canCreate = false}: { onOpenGrant: (kb: IndustryKbRow) => void; canCreate?: boolean }){
  const [openNew, setOpenNew] = useState(false);
  const [adminTarget, setAdminTarget] = useState<IndustryKbRow | null>(null);
  const [confirmDel, setConfirmDel] = useState<IndustryKbRow | null>(null);
  const [search, setSearch] = useState('');

  const filtered = appStore.INDUSTRY_KBS.filter(k => {
    if (!search) return true;
    const q = search.toLowerCase();
    return k.name.toLowerCase().includes(q) || (k.desc || '').toLowerCase().includes(q) || k.admins.some((a: any) => (a.n || a.i || '').toLowerCase().includes(q));
  });

  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:20}}>
        <div>
          <div className="h1">行业知识库管理</div>
          <div className="subline">跨部门与专业领域知识资产库 · 支持向全企业人员/角色/组织维度进行细粒度授权 · 组织授权自动继承至新成员</div>
        </div>
        {canCreate && (
          <button className="btn primary" onClick={()=>setOpenNew(true)}>
            <Icon name="plus" size={12}/> 新建行业库
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <div className="admin-toolbar-left">
          <div className="search-input">
            <input placeholder="搜索行业库名称 / 描述 / 管理员…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          {search && (
            <button className="btn" style={{padding:'4px 8px',fontSize:'11.5px'}} onClick={()=>setSearch('')}>
              重置
            </button>
          )}
        </div>
        <div className="toolbar-count">
          共 {filtered.length} / {appStore.INDUSTRY_KBS.length} 个行业知识库
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{width:'26%'}}>知识库名称</th>
              <th>描述说明</th>
              <th style={{width:130}}>管理员团队</th>
              <th style={{width:130,textAlign:'center'}}>授权生效范围</th>
              <th style={{width:210,textAlign:'right'}}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{textAlign:'center',padding:'40px 0',color:'var(--ink-4)'}}>
                  <div style={{marginBottom:'8px',color:'var(--ink-3)'}}><Icon name="book" size={28}/></div>
                  <div>没有匹配的行业知识库</div>
                </td>
              </tr>
            ) : filtered.map(k => (
              <tr key={k.id}>
                <td>
                  <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                    <div style={{fontSize:'18px',lineHeight:'1.2'}}>📘</div>
                    <div>
                      <div style={{fontWeight:600,color:'var(--ink)',fontSize:'13px'}}>{k.name}</div>
                      <div style={{marginTop:3,display:'flex',alignItems:'center',gap:6}}>
                        <span className="badge ok" style={{fontSize:'10px',padding:'1px 5px'}}>行业库</span>
                        <span style={{fontSize:'11px',color:'var(--ink-3)'}}>
                          {k.docs} 份文档 · {k.created}
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span style={{color:'var(--ink-2)',fontSize:'12px',lineHeight:'1.5'}}>{k.desc || '暂无描述'}</span>
                </td>
                <td>
                  <div className="avatar-stack">
                    {k.admins.length > 0 ? (
                      k.admins.map((a: any, i: number) => (
                        <div
                          key={i}
                          className="avatar"
                          title={`${a.n || '管理员'} (@${a.i})`}
                          style={{
                            background: i % 2 === 0 ? '#2563eb' : '#059669',
                            color: '#fff'
                          }}
                        >
                          {(a.i || a.n || '管').slice(0, 2).toUpperCase()}
                        </div>
                      ))
                    ) : (
                      <span style={{fontSize:'11.5px',color:'var(--ink-4)'}}>未设置</span>
                    )}
                  </div>
                </td>
                <td style={{textAlign:'center'}}>
                  <button
                    className="badge purple"
                    style={{cursor:'pointer',border:'1px solid #DDD6FE'}}
                    onClick={()=>onOpenGrant(k)}
                    title="点击跳转并查看授权明细"
                  >
                    {k.grants} 个主体 ↗
                  </button>
                </td>
                <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
                  <div className="table-actions">
                    {k.canManage && (
                      <button className="btn" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>setAdminTarget(k)}>
                        管理员
                      </button>
                    )}
                    {k.canGrant && (
                      <button className="btn primary" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>onOpenGrant(k)}>
                        去授权
                      </button>
                    )}
                    {k.canDelete && (
                      <button className="btn danger" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>setConfirmDel(k)}>
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

      {openNew && (
        <NewIndustryKBModal
          onClose={()=>setOpenNew(false)}
          onSaved={()=>{setOpenNew(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}
        />
      )}
      {adminTarget && (
        <KBAdminModal
          kb={adminTarget}
          onClose={()=>setAdminTarget(null)}
          onSaved={()=>{setAdminTarget(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}
        />
      )}
      {confirmDel && (
        <ConfirmModal
          title="删除行业知识库"
          msg={<>确认删除行业库 <b style={{color:'var(--ink)'}}>{confirmDel.name}</b>？共 <b>{confirmDel.docs}</b> 份文档将被归档，已授权主体将无法再访问此库知识。</>}
          onConfirm={async()=>{
            const response = await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${confirmDel.id}`,{method:'DELETE',headers:apiHeaders()});
            if(!response.ok) throw new Error('删除失败');
            window.dispatchEvent(new CustomEvent('app-data-refresh'));
          }}
          onClose={()=>setConfirmDel(null)}
        />
      )}
    </>
  );
}

export function NewIndustryKBModal({onClose, onSaved}: { onClose: () => void; onSaved?: () => void }){
  const [admins, setAdmins] = useState<TagItem[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim() || !description.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/kbs`, {method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name,description,type:'industry'})});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '创建失败');
      if (admins.length && result.knowledgeBase?.id) await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${result.knowledgeBase.id}/admins`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({userIds:admins.map(a=>a.id)})});
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'行业知识库已创建'})); onSaved?.();
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '创建失败'})); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="新建行业知识库" onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}><Icon name="plus" size={12}/> {saving?'创建中…':'创建并初始化'}</button>
      </>
    }>
      <div className="field"><label>库名称<span className="req">*</span></label><input value={name} onChange={e=>setName(e.target.value)} placeholder="如：跨境贸易合规库 / AI 治理与伦理库"/></div>
      <div className="field"><label>库描述<span className="req">*</span></label><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="说明本库的范围、用途、收录规范"/></div>
      <div className="field">
        <label>管理员（1 人或多人）<span className="req">*</span></label>
        <TagPicker placeholder="搜索并选择管理员..." items={appStore.USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={admins} setSelected={setAdmins}/>
        <div className="field-hint">管理员拥有该库的全部维护权限：上传/编辑/删除文档、设置授权主体。</div>
      </div>
      <div className="warn-strip"><Icon name="alert" size={12}/>创建后可立即上传文档；文档解析和大脑编译由后台异步完成。</div>
    </Modal>
  );
}

export function KBAdminModal({kb, onClose, onSaved}: { kb: IndustryKbRow; onClose: () => void; onSaved?: () => void }){
  const currentAdmins = appStore.USERS.filter(u => kb.admins.some(a=>a.n===u.name));
  const [picked, setPicked] = useState<TagItem[]>(currentAdmins.map(u=>({id:u.id,n:u.name,sub:u.org})));
  const remove = currentAdmins.filter(u => !picked.find(p=>p.id===u.id));
  const save = async () => {
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${kb.id}/admins`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({userIds:picked.map(p=>p.id)})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) { window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '保存失败'})); return; }
    window.dispatchEvent(new CustomEvent('app-toast',{detail:'管理员设置已保存'})); onSaved?.();
  };
  return (
    <Modal title={`管理员设置 · ${kb.name}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={save}>保存设置</button>
      </>
    }>
      <div style={{fontSize:12.5,color:'var(--ink-3)',marginBottom:14,lineHeight:1.5}}>
        管理员拥有该库的<strong style={{color:'var(--ink)'}}>全部维护权限</strong>：上传 / 编辑 / 删除文档、设置授权主体、配置检索参数。支持多人共管，任免均有审计记录。
      </div>
      <div className="field">
        <label>当前管理员（{picked.length} 人）</label>
        <TagPicker placeholder="搜索并添加管理员..." items={appStore.USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={picked} setSelected={setPicked}/>
      </div>
      {remove.length>0 && (
        <div className="warn-strip">
          <Icon name="alert" size={12}/>
          即将移除 {remove.length} 名管理员：{remove.map(u=>u.name).join('、')} · 他们的管理权限将立即失效。
        </div>
      )}
      <div style={{marginTop:14,padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.55}}>
        <b style={{color:'var(--ink)'}}>提示</b>：管理员可被授予但不能自我免除；至少保留 1 名管理员，避免「无主知识库」。如需彻底取消管理，请联系超级管理员。
      </div>
    </Modal>
  );
}

