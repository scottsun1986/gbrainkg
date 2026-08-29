"use client";
/*
 * This file is the migrated interactive prototype.  The prototype was authored
 * as JavaScript and intentionally keeps a number of flexible data shapes while
 * the API contract is being finalized.  Runtime behaviour is covered by the
 * API/e2e checks; keep the migration from blocking the production bundle on
 * prototype-only structural typing noise.
 */
/* eslint-disable */
import React, { useState, useEffect, useRef, useMemo } from "react";

declare global {
  interface Window { DocsAPI?: any; }
}

// Child prototype components are defined outside App and cannot see App's
// loading state.  This sentinel keeps their guards safe; App owns the real
// loading state below.
const dbData = true;
// 生产构建会注入 NEXT_PUBLIC_API_URL；保留按当前访问主机推导的兜底，
// 避免构建环境漏配时把登录/问答请求错误地发回 Web 端口。
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || (
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3202`
    : 'http://localhost:3202'
);
const apiHeaders = () => {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('llmwiki_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
};


/* ============== 设计系统常量 ============== */
const COLORS = {
  evidence:'#B7791F',
  evidenceSoft:'#F5E9C9',
};

/* ============== 内联 SVG 图标（克制使用·承载信息） ============== */
const Icon = ({name, size=16, stroke=1.6, color='currentColor', ...svgProps}: any) => {
  const s = size, sw = stroke;
  const paths = {
    chat: <><path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></>,
    setting: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    search: <><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7z"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>,
    user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    folder: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
    doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/></>,
    chevron: <><polyline points="9 18 15 12 9 6"/></>,
    history: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></>,
    list: <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>,
    model: <><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M10.4 14.6 7 19"/><path d="m13.6 9.4 4.4-2.9"/><path d="M10.4 9.4 7 5"/><path d="m13.6 14.6 4.4 2.9"/></>,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    refresh: <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></>,
    spark: <><polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2"/></>,
    pin: <><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76l3 3.34V17H6v-2.9l3-3.34z"/></>,
    share: <><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></>,
    more: <><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>,
    help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    arrowleft: <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <svg {...svgProps} width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{flex:'0 0 auto',display:'inline-block', ...(svgProps.style || {})}}>
      {paths[name]}
    </svg>
  );
};

/* ============== API 数据缓存（仅作为当前会话的渲染缓存，不作为业务数据源） ============== */
let KNOWLEDGE_BASES: any[] = [];
let CONVERSATIONS: any[] = [];
let CITATIONS: any[] = [];
let FOLLOWUPS: string[] = [];
let DOCS: any[] = [];

let ORG_TREE: any = null;
let GRANTS: any[] = [];
let MODELS: any = {llm:[], embedding:[], rerank:[]};
let AUDIT: any[] = [];
let USERS: any[] = [];
let ROLES: any[] = [];
let INDUSTRY_KBS: any[] = [];
let PROVIDERS: any[] = [];
let CAPABILITIES: string[] = [];

const hasCapability = (permission: string, capabilities = CAPABILITIES) => capabilities.includes('*') || capabilities.includes(permission);

const TYPE_LABEL = {personal:'个人', org:'组织', industry:'行业', user:'人员', role:'角色'};
const TYPE_BADGE = (type) => <span className={`badge ${type}`}>{TYPE_LABEL[type] || type}</span>;

/* ============== 通用组件 ============== */

function SideNav({active, setActive, user, onLogout, kbCount=0, capabilities=[]}){
  const items = [
    {key:'chat', label:'对话', icon:'chat', badge:null},
    {key:'libs', label:'知识库', icon:'book', badge:kbCount ? String(kbCount) : null},
    {key:'graph', label:'知识图谱', icon:'share', badge:null},
  ].filter(item => hasCapability(item.key === 'chat' ? 'chat.use' : 'kb.read', capabilities));
  const canAdmin = capabilities.includes('*') || ['org.read','org.user.read','role.read','kb.industry.read','kb.industry.create','kb.industry.grant','audit.read'].some(permission => capabilities.includes(permission));
  const canSettings = hasCapability('system.settings.read', capabilities) || hasCapability('system.settings.manage', capabilities);
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <aside className="side">
      <div className="brand">
        <span className="brand-mark">[</span>
        <span>LLM Wiki</span>
      </div>
      <nav className="nav">
        <div className="nav-section">工作</div>
        {items.map(it => (
          <div key={it.key} className={`nav-item ${active===it.key?'active':''}`} onClick={()=>setActive(it.key)}>
            <Icon name={it.icon} size={16} className="nav-ic"/>
            <span>{it.label}</span>
            {it.badge && <span className="nav-badge">{it.badge}</span>}
          </div>
        ))}
        <div className="nav-section">管理</div>
        {canAdmin && <div className={`nav-item ${active==='admin'?'active':''}`} onClick={()=>setActive('admin')}>
          <Icon name="shield" size={16} className="nav-ic"/>
          <span>管理后台</span>
        </div>}
        {canSettings && <div className={`nav-item ${active==='settings'?'active':''}`} onClick={()=>setActive('settings')} title="模型、供应商与系统级配置">
          <Icon name="setting" size={16} className="nav-ic"/>
          <span>系统设置</span>
        </div>}
      </nav>
      <div className="side-foot">
        <div className="avatar">{String(user?.username || user?.displayName || '用户').slice(0,2).toUpperCase()}</div>
        <div className="user-info">
          <div className="user-name">{user?.displayName || user?.username || '当前用户'}</div>
          <div className="user-role">{user?.orgs?.map((item:any)=>item.orgNode?.name).filter(Boolean).join('、') || '未分配组织'} · {user?.roles?.[0]?.role?.name || '普通用户'}</div>
        </div>
        <button className="logout-btn" onClick={onLogout} title="退出登录" aria-label="退出登录">
          <Icon name="logout" size={14} color="var(--ink-3)"/>
          <span>退出</span>
        </button>
      </div>
    </aside>
  );
}

/* ============== Modal ============== */
function Modal({title, onClose, children, foot}){
  useEffect(()=>{
    const onKey = (e)=>{ if(e.key==='Escape') onClose(); };
    document.addEventListener('keydown', onKey);
  return ()=>document.removeEventListener('keydown', onKey);
  },[]);
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="x" onClick={onClose}>×</span>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

async function fetchOnlinePreviewConfig(kbId, documentId) {
  const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${documentId}/preview-config`, {headers: apiHeaders()});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || '在线预览配置加载失败');
  return result;
}

// 官方 OnlyOffice Docs API 的只读封装。文档内容仍由 API 通过短时签名
// URL 提供，因此不会把登录 Bearer token 暴露给文档服务器或地址栏。
function OnlineDocumentViewer({preview}) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const editorId = useMemo(() => `onlyoffice-${Math.random().toString(36).slice(2)}`, []);
  useEffect(() => {
    if (!preview?.documentServerUrl || !preview?.config || !hostRef.current) return undefined;
    let disposed = false;
    const start = () => {
      if (disposed || !window.DocsAPI || !hostRef.current) return;
      editorRef.current = new window.DocsAPI.DocEditor(editorId, preview.config);
    };
    const scriptId = 'onlyoffice-docs-api';
    const existing = document.getElementById(scriptId);
    if (existing) {
      if (window.DocsAPI) start();
      else existing.addEventListener('load', start, {once:true});
    } else {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `${preview.documentServerUrl.replace(/\/$/, '')}/web-apps/apps/api/documents/api.js`;
      script.onload = start;
      script.onerror = () => window.dispatchEvent(new CustomEvent('app-toast',{detail:'在线预览组件加载失败，请检查 OnlyOffice 服务'}));
      document.body.appendChild(script);
    }
    return () => {
      disposed = true;
      try { editorRef.current?.destroyEditor?.(); } catch {}
      editorRef.current = null;
    };
  }, [preview, editorId]);
  return <div ref={hostRef} id={editorId} style={{width:'100%',height:'68vh',minHeight:480}}/>;
}

function OnlinePreviewModal({preview, onClose}) {
  if (!preview) return null;
  return <Modal title={`在线预览 · ${preview.title}`} onClose={onClose} foot={<button className="btn" onClick={onClose}>关闭</button>}>
    <div style={{margin:'-8px -4px -4px',minHeight:480,background:'#f5f6f8'}}><OnlineDocumentViewer preview={preview}/></div>
  </Modal>;
}

/* Tag picker - multi-select with chips */
function TagPicker({placeholder, items, selected, setSelected}){
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = items.filter(it => !selected.find(s=>s.id===it.id) && ((it.name||'').includes(q) || (it.n||'').includes(q)));
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div style={{position:'relative'}}>
      <div className="tag-input" onClick={()=>setOpen(true)}>
        {selected.map(s=>(
          <span key={s.id} className="chip">
            {s.n || s.name}
            <span className="x" onClick={(e)=>{e.stopPropagation(); setSelected(selected.filter(x=>x.id!==s.id));}}>×</span>
          </span>
        ))}
        <input
          placeholder={selected.length===0 ? placeholder : ''}
          value={q}
          onChange={e=>{setQ(e.target.value); setOpen(true);}}
          onFocus={()=>setOpen(true)}
          onBlur={()=>setTimeout(()=>setOpen(false), 150)}
          style={{flex:1,minWidth:80,border:'none',outline:'none',background:'transparent',fontSize:'12.5px',padding:'4px 4px'}}
        />
      </div>
      {open && filtered.length>0 && (
        <div className="tag-suggest" style={{top:38,left:0,right:0}}>
          {filtered.map(it=>(
            <div key={it.id} className="ts" onMouseDown={()=>{ setSelected([...selected, it]); setQ(''); }}>
              <span style={{color:'var(--ink)',fontWeight:500}}>{it.n || it.name}</span>
              <span style={{color:'var(--ink-4)',marginLeft:6,fontSize:11}}>{it.sub || it.org || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Confirm modal */
function ConfirmModal({title, msg, onConfirm, onClose}){
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={title} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn danger" onClick={()=>{onConfirm(); onClose();}}>确认删除</button>
      </>
    }>
      <div style={{fontSize:13,color:'var(--ink-2)',lineHeight:1.6}}>{msg}</div>
    </Modal>
  );
}

function TopBar({title, sub}){
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div className="topbar">
      <div className="crumb"><b>{title}</b>{sub && <> · <span style={{color:'var(--ink-3)'}}>{sub}</span></>}</div>
      <div className="topbar-spacer"/>
      <div className="topbar-actions">
        <button className="icon-btn" title="搜索" onClick={()=>window.dispatchEvent(new CustomEvent('app-toast',{detail:'请使用当前页面的知识库筛选或会话列表搜索'}))}><Icon name="search" size={16}/></button>
        <button className="icon-btn" title="通知" onClick={()=>window.dispatchEvent(new CustomEvent('app-toast',{detail:'当前没有未读通知'}))}><Icon name="bell" size={16}/></button>
        <button className="icon-btn" title="帮助" onClick={()=>window.dispatchEvent(new CustomEvent('app-toast',{detail:'可从知识库上传文档，再在对话中选择可见范围提问'}))}><Icon name="help" size={16}/></button>
      </div>
    </div>
  );
}

/* ============== 范围选择器 ============== */
function ScopePicker({visibleKbs, selected, setSelected, open, setOpen}){
  const wrapRef = useRef(null);
  useEffect(()=>{
    const onDoc = (e)=>{ if(wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e)=>{ if(e.key==='Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
  return ()=>{ document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  },[]);
  const groups = [
    {label:'个人库', items: visibleKbs.filter(k=>k.type==='personal')},
    {label:'组织库', items: visibleKbs.filter(k=>k.type==='org')},
    {label:'行业库', items: visibleKbs.filter(k=>k.type==='industry')},
  ];
  const totalSel = selected.length;
  const totalAll = visibleKbs.length;
  const scopeLabel = totalSel===totalAll ? '我可见的全部' : (totalSel===0 ? '未选择任何库' : `已选 ${totalSel} 库`);
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div ref={wrapRef} style={{position:'relative'}}>
      <button className="scope-trigger" onClick={()=>setOpen(!open)} title="调整本次对话的检索范围">
        <span className="scope-dot" style={{background: totalSel===0 ? 'var(--ink-4)' : 'var(--evidence)'}}/>
        <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{scopeLabel}</span>
        <span className="scope-meta">{totalSel}/{totalAll} 库</span>
        <Icon name="chevron" size={14} color="var(--ink-3)" style={{transform: open?'rotate(-90deg)':'rotate(90deg)', transition:'transform .15s'}}/>
      </button>
      {open && (
        <div className="scope-pop">
          <h5>选择查询范围</h5>
          <div style={{maxHeight:340,overflowY:'auto'}}>
            {groups.map(g => (
              <div className="group" key={g.label}>
                <div className="gh">
                  <span>{g.label}</span>
                  <span>{g.items.length} 个</span>
                </div>
                {g.items.map(k => {
                  const checked = selected.includes(k.id);
                  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                      <div key={k.id} className="gi" onClick={()=>{
                        setSelected(checked ? selected.filter(x=>x!==k.id) : [...selected, k.id]);
                      }}>
                        <input type="checkbox" checked={checked} onChange={()=>{}} style={{accentColor:'var(--ink)'}}/>
                        <span className="gname">{k.name}</span>
                        <span className="gvis">{k.visibility || '—'}</span>
                      </div>
                    );
                })}
              </div>
            ))}
          </div>
          <div className="foot">
            <button onClick={()=>setSelected(visibleKbs.map(k=>k.id))}>全选</button>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>setSelected([])}>清空</button>
              <button className="primary" onClick={()=>setOpen(false)}>应用</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============== 对话屏 ============== */
function ChatScreen(){
  const visibleKbs = KNOWLEDGE_BASES;
  const [selected, setSelected] = useState([]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);   // {role:'user'|'ai', text, done}
  const [streaming, setStreaming] = useState(false);
  const [activeCite, setActiveCite] = useState(null);
  const [activeConv, setActiveConv] = useState(null);
  const [conversationList, setConversationList] = useState(CONVERSATIONS);
  const [citations, setCitations] = useState([]);
  const [onlinePreview, setOnlinePreview] = useState(null);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const chatFileRef = useRef(null);

  const allSel = selected.length === visibleKbs.length;
  const scopeLabel = allSel ? '我可见的全部' : (selected.length === 0 ? '未选择任何库' : `已选 ${selected.length} 库`);

  // 真实流式输出状态机对接
  useEffect(() => {
    setSelected(visibleKbs.map(k=>k.id));
    setConversationList(CONVERSATIONS);
    const refresh = () => { setConversationList([...CONVERSATIONS]); setSelected(visibleKbs.map(k=>k.id)); };
    window.addEventListener('app-data-refresh', refresh);
    return () => window.removeEventListener('app-data-refresh', refresh);
  }, [visibleKbs.length]);

  useEffect(() => {
    if (!streaming) return;
    let active = true;
    const controller = new AbortController();

    const updateAssistant = (text, done) => {
      if (!active) return;
      setMessages(ms => {
        const cp = [...ms];
        const last = cp[cp.length - 1];
        // 用户可能在流结束的同时点击了“新对话”，避免迟到的网络事件
        // 覆盖新状态或访问不存在的消息。
        if (!last || last.role !== 'ai') return ms;
        cp[cp.length - 1] = { ...last, text, done };
        return cp;
      });
    };

    (async () => {
      try {
        const userMsg = messages[messages.length - 2]?.text || "";
        const res = await fetch(`${API_BASE_URL}/api/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ message: userMsg, kb_scope: selected, conversation_id: activeConv || undefined }),
          signal: controller.signal,
        });
        
        if (!res.ok) {
          let detail = `API Error (${res.status})`;
          try {
            const payload = await res.json();
            detail = payload?.message || payload?.error || detail;
          } catch (e) {}
          throw new Error(detail);
        }
        
        const reader = res.body?.getReader();
        if (!reader) throw new Error("服务器未返回有效的流式响应");
        const decoder = new TextDecoder('utf-8');
        let accumulatedText = "";
        let buffer = '';
        let streamFinished = false;

        const consumeLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const payload = trimmed.slice(6).trim();
          if (!payload || payload === '[DONE]') return;
          const data = JSON.parse(payload);
          if (data.type === 'delta') {
            accumulatedText += String(data.content || '');
            updateAssistant(accumulatedText, false);
          } else if (data.type === 'error') {
            throw new Error(String(data.content || '问答服务返回错误'));
          } else if (data.type === 'conversation') {
            setActiveConv(data.conversation_id);
            setConversationList(list => [{ id: data.conversation_id, title: userMsg.slice(0, 120), createdAt: new Date().toISOString() }, ...list.filter(item => item.id !== data.conversation_id)]);
          } else if (data.type === 'citation') {
            const citation = { id: `${data.index}-${data.topic_slug}`, title: data.timeline_entry?.doc_title || data.topic_slug || '知识主题', kb: data.timeline_entry?.source_kb, documentId: data.timeline_entry?.document_id, kbName: data.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: '刚刚', snippet: data.timeline_entry?.snippet || '', path: data.topic_slug };
            setCitations(items => [...items, citation]);
            setMessages(items => {
              const next = [...items];
              const lastIndex = next.map(item => item.role).lastIndexOf('ai');
              if (lastIndex >= 0) next[lastIndex] = { ...next[lastIndex], sources: [...(next[lastIndex].sources || []), citation] };
              return next;
            });
          } else if (data.type === 'done') {
            streamFinished = true;
          }
        };

        while (!streamFinished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) consumeLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) consumeLine(buffer);
        updateAssistant(accumulatedText, true);
        if (active) setStreaming(false);
      } catch (err) {
         if (active && err?.name !== 'AbortError') {
           updateAssistant("大模型请求失败：" + (err?.message || '未知错误'), true);
           setStreaming(false);
         }
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [streaming]);

  // 流式期间自动滚底
  useEffect(()=>{
    const el = scrollRef.current;
    if(el) el.scrollTop = el.scrollHeight;
  },[messages]);

  const send = (preset?: string)=>{
    const text = (preset ?? input).trim();
    if(!text || streaming || selected.length===0) return;
    setMessages(ms=>[...ms, {role:'user', text}, {role:'ai', text:'', done:false}]);
    setInput('');
    setActiveCite(null);
    setCitations([]);
    setStreaming(true);
    if(taRef.current) taRef.current.style.height = 'auto';
  };

  const newChat = ()=>{
    setMessages([]); setStreaming(false); setActiveCite(null); setCitations([]); setActiveConv(null); setInput('');
    if(taRef.current){ taRef.current.style.height = 'auto'; taRef.current.focus(); }
  };

  const copyAnswer = async (text) => { try { await navigator.clipboard.writeText(text); window.dispatchEvent(new CustomEvent('app-toast',{detail:'回答已复制'})); } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'复制失败，请检查浏览器权限'})); } };
  const shareConversation = async () => { const url = window.location.href; try { if (navigator.share) await navigator.share({title:'LLM Wiki 对话',url}); else await navigator.clipboard.writeText(url); window.dispatchEvent(new CustomEvent('app-toast',{detail:navigator.share?'已打开分享面板':'会话链接已复制'})); } catch {} };
  const saveFeedback = async (feedback) => {
    if (!activeConv) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}` ,{headers:apiHeaders()});
      const conversation = await response.json(); const message = [...(conversation.messages || [])].reverse().find(item=>item.role==='assistant');
      if (message) { await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}/messages/${message.id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({feedback})}); window.dispatchEvent(new CustomEvent('app-toast',{detail:'反馈已记录'})); }
    } catch {}
  };

  const previewCitation = async (citation) => {
    if (!citation?.kb || !citation?.documentId) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'当前引用没有可预览的原始文档'}));
      return;
    }
    try {
      const config = await fetchOnlinePreviewConfig(citation.kb, citation.documentId);
      setOnlinePreview({title: citation.title || '原始文档', ...config});
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '原始来源预览失败'})); }
  };
  const uploadAttachment = async (file) => {
    const targetKb = KNOWLEDGE_BASES.find(k => k.id === selected[0]);
    if (!file || !selected[0] || !targetKb?.canWrite) {
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'当前查询范围没有可写入的知识库，请切换到有维护权限的库'}));
      return;
    }
    const form = new FormData(); form.append('file', file);
    const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${selected[0]}/documents`, {method:'POST',headers:apiHeaders(),body:form});
    const result = await response.json().catch(()=>({}));
    window.dispatchEvent(new CustomEvent('app-toast',{detail:response.ok?'附件已上传并进入解析队列':result.message || '附件上传失败'}));
    if (response.ok) window.dispatchEvent(new CustomEvent('app-data-refresh'));
  };

  const openConversation = async (id) => {
    if (streaming || !id) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('会话加载失败');
      const conversation = await response.json();
      setActiveConv(id);
      setMessages((conversation.messages || []).map(message => ({
        role: message.role === 'assistant' ? 'ai' : 'user',
        text: message.content,
        done: true,
        sources: message.role === 'assistant' && Array.isArray(message.citationsSummary) ? message.citationsSummary.map((cite, index) => ({ id: `${message.id}-${index}`, title: cite.timeline_entry?.doc_title || cite.topic_slug || '知识主题', kb: cite.timeline_entry?.source_kb, documentId: cite.timeline_entry?.document_id, kbName: cite.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: new Date(message.createdAt).toLocaleString('zh-CN'), snippet: cite.timeline_entry?.snippet || '', path: cite.topic_slug })) : [],
      })));
      setCitations((conversation.messages || []).flatMap(message => Array.isArray(message.citationsSummary) ? message.citationsSummary.map((cite, index) => ({ id: `${message.id}-${index}`, title: cite.timeline_entry?.doc_title || cite.topic_slug || '知识主题', kb: cite.timeline_entry?.source_kb, documentId: cite.timeline_entry?.document_id, kbName: cite.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: new Date(message.createdAt).toLocaleString('zh-CN'), snippet: cite.timeline_entry?.snippet || '' })) : []));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail: error.message || '会话加载失败'})); }
  };

  const focusInput = ()=>{ if(taRef.current) taRef.current.focus(); };

  const autoGrow = (el)=>{
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const renderAnswer = (typed) => {
    // 渲染 typed 文本：处理 **粗体** 与 [n] 引用 chip
    const out = [];
    let key = 0;
    const segs = typed.split(/(\*\*[^*]+\*\*)/g);
    segs.forEach(seg => {
      if(!seg) return;
      const isBold = /^\*\*[^*]+\*\*$/.test(seg);
      const text = isBold ? seg.slice(2,-2) : seg;
      const wrap = (s, k) => isBold ? <strong key={k}>{s}</strong> : <span key={k}>{s}</span>;
      const re = /\[(\d+)\]/g; let last = 0; let m;
      while((m = re.exec(text)) !== null){
        if(m.index > last) out.push(wrap(text.slice(last, m.index), key++));
        const n = parseInt(m[1],10);
        out.push(<button key={key++} className={`cite-chip ${activeCite===n?'active':''}`} onClick={()=>{setActiveCite(n); const citation = citations[n-1]; if (citation?.documentId) void previewCitation(citation);}}>{n}</button>);
        last = m.index + m[0].length;
      }
      if(last < text.length) out.push(wrap(text.slice(last), key++));
    });
    return out;
  };

  const answerDone = messages.length>0 && messages[messages.length-1].done;

  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div className="chat">
      <div className="conv-side">
        <div className="scope">
          <div className="scope-label">查询范围</div>
          <ScopePicker visibleKbs={visibleKbs} selected={selected} setSelected={setSelected} open={open} setOpen={setOpen}/>
        </div>
        <div className="conv-head">
          <h4>最近会话</h4>
          <button className="icon-btn" title="new" onClick={newChat}><Icon name="plus" size={14}/></button>
        </div>
        <div className="conv-list">
          {conversationList.map(c => (
            <div key={c.id} className={`conv-item ${activeConv===c.id?'active':''}`} onClick={()=>openConversation(c.id)}>
              <span>{c.title}</span>
              <span className="conv-time">{c.createdAt ? new Date(c.createdAt).toLocaleDateString('zh-CN') : ''}</span>
            </div>
          ))}
        </div>
        <div className="new-chat" onClick={newChat} title="开始一段新对话">
          <Icon name="plus" size={12}/> 新建会话
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-inner">
            {messages.length===0 && (
              <div className="welcome">
                <h1>问你的大脑。<em>答案可溯源</em>。</h1>
                <p>这不是搜索碎片——是一份<b>为你持续整理的个人大脑</b>：每当有新知识入库或权限变更，后台都会为你重新编译主题页（Compiled Truth + Timeline 证据链）。回答来自整理好的结论，每条引用可回溯原始文档。</p>
                <div className="suggest">
                  {['数据出境安全评估的新规对申报材料有什么要求？','研发中心的 AI 平台架构是怎样的？','我之前参与过哪些出境评估项目？','Casbin 模型如何支持三级知识库？'].map((q,i)=>(
                    <button key={i} onClick={()=>send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, mi)=>{
              const isLast = mi === messages.length-1;
              if(msg.role==='user'){
                if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                  <div key={mi} className="msg msg-user">
                    <div className="bubble">{msg.text}</div>
                  </div>
                );
              }
              if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                <div key={mi} className="msg msg-ai">
                  <div className="body">
                    <div className="who">
                      <span className="dot"/>
                      <span>LLMWiki · 大脑综述</span>
                      <span style={{color:'var(--ink-4)'}}>· 你的大脑 · {scopeLabel}{allSel ? `（${selected.length} 库）` : ''}</span>
                    </div>
                    <div className="answer">
                      {renderAnswer(msg.text)}
                      {!msg.done && <span className="cursor"/>}
                    </div>
                    {msg.done && msg.sources?.length > 0 && <div className="answer-sources"><span>来源：</span>{msg.sources.map((source, index) => <button key={source.id || index} onClick={()=>previewCitation(source)} title="打开原始文档预览">[{index + 1}] {source.title}</button>)}</div>}
                    {msg.done && (
                      <>
                        <div className="actions">
                          <button onClick={()=>copyAnswer(msg.text)}><Icon name="copy" size={12}/> 复制</button>
                          <button onClick={()=>send([...messages].reverse().find(item=>item.role==='user')?.text)}><Icon name="refresh" size={12}/> 重写</button>
                          <button onClick={shareConversation}><Icon name="share" size={12}/> 分享</button>
                          <button style={{marginLeft:'auto'}} onClick={()=>saveFeedback('useful')}><Icon name="check" size={12}/> 有用</button>
                        </div>

                        <details className="retrieval">
                          <summary>
                            <Icon name="spark" size={12} color="var(--evidence)"/>
                            <span>大脑整理与查询 ·</span>
                            <b>命中主题页 × 3 · Compiled Truth 作答</b>
                            <span style={{marginLeft:'auto',fontSize:11}}>展开 ▾</span>
                          </summary>
                          <div className="retrieval-body">
                            <div className="ret-step"><span className="n">1</span><span className="txt"><b>权限视图</b> · 你的大脑边界 = 可见 {selected.length}/{visibleKbs.length} 库（范围：{scopeLabel}）· 权限变更会触发大脑重编译</span><span className="v">{selected.length} 库</span></div>
                            <div className="ret-step"><span className="n">2</span><span className="txt"><b>大脑查询</b> · gbrain 查询命中真实主题页</span><span className="v">{citations.length} 页</span></div>
                            <div className="ret-step"><span className="n">3</span><span className="txt"><b>Compiled Truth 作答</b> · 回答来自当前知识库编译结果</span><span className="v">{citations.length} 条证据</span></div>
                            <div className="ret-step"><span className="n">4</span><span className="txt"><b>证据链对齐</b> · 回答引用 ↔ 知识页 ↔ 原始文档</span><span className="v">实时</span></div>
                          </div>
                        </details>

                        {isLast && (
                          <div className="followup">
                            <h5>建议追问</h5>
                            <ul>
                              {FOLLOWUPS.map((q,i)=>(
                                <li key={i} onClick={()=>{setInput(q); focusInput();}}>→ {q}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <textarea
                ref={taRef}
                placeholder={selected.length===0 ? '请先在左侧选择至少一个知识库…' : '向你的知识库提问…（Enter 发送，Shift+Enter 换行）'}
                value={input}
                onChange={e=>{setInput(e.target.value); autoGrow(e.target);}}
                onKeyDown={e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send();} }}
                rows={1}
              />
              <div className="composer-foot">
                <div className="comp-chip" onClick={()=>setOpen(true)} style={{cursor:'pointer'}} title="调整查询范围">
                  <span className="scope-dot" style={{width:6,height:6}}/>
                  范围 · {scopeLabel}
                  <span className="kbd">⌘K</span>
                </div>
                <input ref={chatFileRef} type="file" hidden accept=".md,.txt,.csv,.html,.htm,.doc,.docx,.pdf,.xlsx,.pptx,.png,.jpg,.jpeg" onChange={e=>{const file=e.target.files?.[0]; if(file) void uploadAttachment(file); e.target.value='';}}/>
                <div className="comp-chip" style={{opacity:KNOWLEDGE_BASES.find(k => k.id === selected[0])?.canWrite ? .7 : .4,cursor:KNOWLEDGE_BASES.find(k => k.id === selected[0])?.canWrite ? 'pointer' : 'not-allowed'}} onClick={()=>KNOWLEDGE_BASES.find(k => k.id === selected[0])?.canWrite && chatFileRef.current?.click()}>
                  <Icon name="pin" size={11}/> 上传附件
                </div>
                <button className="send-btn" onClick={()=>send()} disabled={!input.trim() || streaming || selected.length===0} title={streaming?'回答生成中…':'发送 (Enter)'}><Icon name="send" size={14} color="#fff"/></button>
              </div>
            </div>
            <div className="foot-note">回答来自你的个人大脑（Compiled Truth）· 新知识入库与权限变更均触发面向你的重编译 · 引用可回溯原始文档</div>
          </div>
        </div>
      </div>

      {answerDone && (
        <div className="cite-panel">
          <div className="cite-head">
            <div style={{display:'flex',alignItems:'center'}}>
              <h4>大脑引用</h4><span className="count">{citations.length}</span>
            </div>
            <div className="cite-sort"><span>主题相关度</span><Icon name="chevron" size={11} color="var(--ink-3)" style={{transform:'rotate(90deg)'}}/></div>
          </div>
          <div className="cite-body">
            {citations.map((c, idx) => {
              const n = idx+1;
              // 原型引用中的 i1/o1 等旧 ID 可能与数据库真实 UUID 不同；
              // 引用仍应可读，不能因为元数据未匹配而让整页崩溃。
              const kb = KNOWLEDGE_BASES.find(k=>k.id===c.kb) || {
                type: 'industry',
                name: c.kbName || '知识库',
              };
              if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                <div key={c.id} className={`cite-card ${activeCite===n?'active':''}`} onMouseEnter={()=>setActiveCite(n)} onClick={()=>setActiveCite(n)}>
                  <div className="top">
                    <span className="num">{n}</span>
                    <div className="ttl">{c.title}</div>
                  </div>
                  <div className="meta">
                    {TYPE_BADGE(kb.type)} <span style={{color:'var(--ink-4)'}}>·</span> <span>{c.kbName}</span> <span style={{flex:1}}/>
                    <span className="badge evidence" style={{fontSize:10,padding:'1px 6px'}} title="编译版本：该主题页在你大脑中的第 N 次整理">Truth {c.truth}</span>
                  </div>
                  <div className="snippet">{c.snippet}</div>
                  <div className="evid-line" title="该主题页 Timeline 中的证据条目">
                    <Icon name="list" size={11} color="var(--evidence)"/> Timeline · {c.evidences} 条证据 · 最近更新 {c.lastUpdate}
                  </div>
                  <div className="acts">
                    <button className="primary" onClick={(e)=>{e.stopPropagation(); void previewCitation(c);}}>打开原始文档</button>
                    <button disabled={!c.documentId} title={c.documentId ? '打开原始文件预览' : '当前历史引用未返回原始文件信息'} onClick={(e)=>{e.stopPropagation(); void previewCitation(c);}}>原始文件</button>
                    <button disabled title="当前部署未配置 Obsidian URI" onClick={(e)=>e.stopPropagation()}>Obsidian</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <OnlinePreviewModal preview={onlinePreview} onClose={()=>setOnlinePreview(null)}/>
    </div>
  );
}

/* ============== 知识库屏 ============== */
function LibrariesScreen({onManageGrant, initialKbId, capabilities = []}){
  const [filter, setFilter] = useState('all');
  const filtered = filter==='all' ? KNOWLEDGE_BASES : KNOWLEDGE_BASES.filter(k=>k.type===filter);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('docs');
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [onlinePreview, setOnlinePreview] = useState(null);
  const [confirmDoc, setConfirmDoc] = useState(null);
  const [confirmKb, setConfirmKb] = useState(null);
  const [newPersonalOpen, setNewPersonalOpen] = useState(false);
  const fileInputRef = useRef(null);
  const current = sel || filtered[0] || null;
  const loadDocuments = async (kbId) => {
    if (!kbId) { setDocs([]); return; }
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents`, {headers:apiHeaders()});
      if (!response.ok) throw new Error('文档列表加载失败');
      const result = await response.json();
      setDocs((result.items || []).map((doc: any) => ({
        id: doc.id, name: doc.title, type: doc.title.split('.').pop() || 'file', size: '—', status: doc.status,
        uploader: doc.uploadedBy?.displayName || doc.uploadedBy?.username || '—', t: new Date(doc.updatedAt || doc.createdAt).toLocaleString('zh-CN'), path: doc.mdPath,
      })));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail: error.message || '文档加载失败'})); }
  };
  useEffect(() => { if (!current && filtered[0]) setSel(filtered[0]); }, [filtered.length]);
  useEffect(() => { const target = KNOWLEDGE_BASES.find(k => k.id === initialKbId); if (target) setSel(target); }, [initialKbId]);
  useEffect(() => { void loadDocuments(current?.id); }, [current?.id]);
  useEffect(() => { const refresh = () => { if (current?.id) void loadDocuments(current.id); }; window.addEventListener('app-data-refresh', refresh); return () => window.removeEventListener('app-data-refresh', refresh); }, [current?.id]);

  const uploadDocument = async (file) => {
    if(uploading || !file || !current?.id) return;
    setUploading(true);
    const tempName = file.name;
    setDocs(ds=>[{id:`temp-${Date.now()}`,name:tempName,type:file.name.split('.').pop()||'file',size:`${(file.size/1024/1024).toFixed(1)} MB`,status:'parsing',uploader:'当前用户',t:'刚刚',path:''}, ...ds]);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents`, { method:'POST', headers:apiHeaders(), body:form });
      const result = await response.json();
      if(!response.ok) throw new Error(result.message || '上传失败');
      const documentId = result.documents?.[0]?.id;
      // 与 API/Docling 的最长解析窗口一致，避免前端 30 秒后把仍在处理
      // 的 PDF/Office 文档显示成失败。
      for(let attempt=0; attempt<600 && documentId; attempt++){
        await new Promise(resolve=>setTimeout(resolve, 500));
        const statusResponse = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents`, {headers:apiHeaders()});
        if(!statusResponse.ok) break;
        const statusResult = await statusResponse.json();
        const polled = statusResult.items?.find(d=>d.id===documentId);
        if(polled?.status === 'published' || polled?.status === 'failed'){
          await loadDocuments(current.id);
          break;
        }
      }
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'上传成功，已进入解析与大脑编译流程。'}));
    } catch(error) {
      setDocs(ds=>ds.map(d=>d.name===tempName?{...d,status:'failed'}:d));
      window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '上传失败'}));
    } finally {
      setUploading(false);
    }
  };

  const previewDocument = async (doc) => {
    try {
      const config = await fetchOnlinePreviewConfig(current.id, doc.id);
      setOnlinePreview({title: doc.name || '原始文档', ...config});
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '文档预览失败'})); }
  };

  const deleteDocument = async (doc) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/${doc.id}`, {method:'DELETE',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '删除失败');
      setConfirmDoc(null);
      await loadDocuments(current.id);
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'知识已删除'}));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '删除失败'})); }
  };

  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  if (!current) return <div style={{padding:40,textAlign:"center",color:"#999"}}>当前账号暂无可见知识库。</div>;
  return (
    <div className="lib">
      <div className="lib-list">
        <div className="lib-head" style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{flex:1}}><h3>知识库</h3><p>共 {KNOWLEDGE_BASES.length} 个 · 你可见 {KNOWLEDGE_BASES.length} 个</p></div>
          <button className="btn" onClick={()=>setNewPersonalOpen(true)}>+ 新建个人库</button>
        </div>
        <div className="lib-tabs">
          {[
            {k:'all', l:'全部', n:KNOWLEDGE_BASES.length},
            {k:'personal', l:'个人', n:KNOWLEDGE_BASES.filter(k=>k.type==='personal').length},
            {k:'org', l:'组织', n:KNOWLEDGE_BASES.filter(k=>k.type==='org').length},
            {k:'industry', l:'行业', n:KNOWLEDGE_BASES.filter(k=>k.type==='industry').length},
          ].map(t=>(
            <div key={t.k} className={`lib-tab ${filter===t.k?'active':''}`} onClick={()=>setFilter(t.k)}>
              <span>{t.l}</span><span className="n">{t.n}</span>
            </div>
          ))}
        </div>
        <div className="lib-body">
          {filtered.map(k=>(
            <div key={k.id} className={`kb-card ${current.id===k.id?'active':''}`} onClick={()=>setSel(k)}>
              <div className="row1">
                <span className="nm">{k.name}</span>
                {TYPE_BADGE(k.type)}
              </div>
              <div className="desc">{k.desc}</div>
              <div className="row2">
                <span><Icon name="doc" size={12}/> {k.docs} 文档</span>
                <span className="vis" title="可见范围"><Icon name={k.type==='personal'?'lock':k.type==='org'?'users':'shield'} size={11}/> <b>{k.visibility}</b></span>
                <span style={{flex:1}}/>
                <span className="admins">
                  {k.admins.map((a,i)=>(<div key={i} className="avatar" style={{background: i%2===0?'#3D6B9E':'#2C7A7B'}}>{a.i}</div>))}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lib-detail">
        <div className="detail-head">
          <div>
            <div className="ttl">{current.name}</div>
            <div className="sub">
              {TYPE_BADGE(current.type)}
              <span><Icon name={current.type==='personal'?'lock':current.type==='org'?'users':'shield'} size={11}/> 可见范围：{current.visibility}</span>
              <span><Icon name="doc" size={11}/> {docs.length} 文档</span>
              <span>· Embedding：<b style={{color:'var(--ink)'}}>bge-m3</b> · 1024 维</span>
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={()=>{const csv=['文档,状态,路径',...docs.map(d=>`${JSON.stringify(d.name)},${d.status},${JSON.stringify(d.path||'')}`)].join('\n'); const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a'); a.href=url; a.download=`${current.name}-documents.csv`; a.click(); URL.revokeObjectURL(url);}}>导出</button>
            {current.type==='industry' && current.canGrant && <button className="btn" onClick={()=>onManageGrant?.(current)}>管理授权</button>}
            {current.type==='personal' && <button className="btn" onClick={()=>window.dispatchEvent(new CustomEvent('app-toast',{detail:'个人库不可共享，权限仅随账号生效'}))}>查看权限</button>}
            {current.type==='personal' && current.canDelete && <button className="btn danger" onClick={()=>setConfirmKb(current)}>删除知识库</button>}
            <input ref={fileInputRef} type="file" hidden onChange={(event)=>{const file=event.target.files?.[0]; if(file) uploadDocument(file); event.target.value='';}} accept=".md,.txt,.csv,.html,.htm,.doc,.docx,.pdf,.xlsx,.pptx,.png,.jpg,.jpeg"/>
            {current.canWrite && <button className="btn primary" onClick={()=>fileInputRef.current?.click()} disabled={uploading}><Icon name="upload" size={12}/> {uploading?'解析中…':'上传文档'}</button>}
          </div>
        </div>
        <div className="detail-tabs">
          <div className={`detail-tab ${tab==='docs'?'active':''}`} onClick={()=>setTab('docs')}>文档（{docs.length}）</div>
          <div className={`detail-tab ${tab==='health'?'active':''}`} onClick={()=>setTab('health')}>健康度</div>
          <div className={`detail-tab ${tab==='settings'?'active':''}`} onClick={()=>setTab('settings')}>设置</div>
        </div>
        <div className="detail-body">
          {tab==='docs' && <>
          {current.canWrite ? <div className="dropzone" onClick={()=>!uploading && fileInputRef.current?.click()} style={{cursor: uploading?'default':'pointer', opacity: uploading?.85:1}}>
            <Icon name="upload" size={26} className="ic" color="var(--ink-3)"/>
            <h5>{uploading ? '已接收 · 正在解析为 Markdown…' : '拖拽文件到此处，或点击选择'}</h5>
            <p>{uploading ? '解析中 → 发布 → 面向可见者编译大脑' : '支持 Markdown / Word（含 .doc / .docx）/ PDF / Excel / PPT / 图片 · 自动解析为 Markdown 入库'}</p>
          </div> : <div className="dropzone" style={{cursor:'default',opacity:.8}}><Icon name="lock" size={24} className="ic" color="var(--ink-3)"/><h5>当前账号仅可阅读</h5><p>只有知识库所有者或管理员可以上传、删除知识。</p></div>}

          <div className="kpi-row">
            <div className="kpi"><div className="lbl">总文档</div><div className="val">{docs.length}</div><div className="sub">来自数据库</div></div>
            <div className="kpi"><div className="lbl">已发布</div><div className="val">{docs.filter(d=>d.status==='published').length}</div><div className="sub">当前库状态</div></div>
            <div className="kpi"><div className="lbl">处理中</div><div className="val">{docs.filter(d=>d.status==='indexing'||d.status==='parsing').length}</div><div className="sub">解析 / 索引队列</div></div>
            <div className="kpi"><div className="lbl">解析失败</div><div className="val" style={{color: docs.filter(d=>d.status==='failed').length? 'var(--danger)':'var(--ink)'}}>{docs.filter(d=>d.status==='failed').length}</div><div className="sub">需人工介入</div></div>
          </div>

          <div className="doc-table">
            <div className="doc-row head" style={{gridTemplateColumns:'30px 1fr 110px 90px 70px 120px'}}>
              <div></div>
              <div>文档</div>
              <div>状态</div>
              <div>上传者</div>
              <div>大小</div>
              <div>操作</div>
            </div>
            {docs.map((d,i)=>(
              <div key={i} className="doc-row" style={{gridTemplateColumns:'30px 1fr 110px 90px 70px 120px'}}>
                <Icon name="doc" size={14} className="ic"/>
                <div>
                  <div className="ttl">{d.name}</div>
                  <div className="sub">{d.path}</div>
                </div>
                <div>
                  <span className={`status ${d.status}`}>
                    <span className="d"/>
                    {d.status==='published'?'已发布':d.status==='indexing'?'索引中':d.status==='parsing'?'解析中':'失败'}
                  </span>
                </div>
                <div style={{color:'var(--ink-2)'}}>{d.uploader} · {d.t}</div>
                <div style={{color:'var(--ink-3)',fontVariantNumeric:'tabular-nums'}}>{d.size}</div>
                <div className="actions" style={{display:'flex',gap:6}}>
                  <button onClick={()=>previewDocument(d)}>预览</button>
                  {current.canWrite && d.status==='failed' && !String(d.id).startsWith('temp-') && <button onClick={async()=>{try{const response=await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/${d.id}/retry`,{method:'POST',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'重试失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'已重新提交解析'})); await loadDocuments(current.id);}catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'重试失败'}));}}}>重试</button>}
                  {current.canWrite && !String(d.id).startsWith('temp-') && <button className="danger" onClick={()=>setConfirmDoc(d)}>删除</button>}
                </div>
              </div>
            ))}
          </div>
          </>}
          {tab==='health' && <div style={{padding:24}}><h3>知识库健康度</h3><p style={{color:'var(--ink-3)'}}>健康度根据当前数据库中的文档状态计算。</p><div className="kpi-row"><div className="kpi"><div className="lbl">已发布率</div><div className="val">{docs.length ? Math.round(docs.filter(d=>d.status==='published').length/docs.length*100) : 0}%</div></div><div className="kpi"><div className="lbl">失败文档</div><div className="val">{docs.filter(d=>d.status==='failed').length}</div></div><div className="kpi"><div className="lbl">待处理</div><div className="val">{docs.filter(d=>d.status==='parsing'||d.status==='indexing').length}</div></div></div></div>}
          {tab==='settings' && <div style={{padding:24}}><h3>知识库设置</h3><div className="field"><label>名称</label><input value={current.name} readOnly/></div><div className="field"><label>类型</label><input value={current.type} readOnly/></div><div className="field"><label>可见性</label><input value={current.visibility} readOnly/></div><p className="field-hint">知识库的权限和管理员请在管理后台维护。</p></div>}
        </div>
      </div>
      {previewDoc && <Modal title={`预览 · ${previewDoc.name}`} onClose={()=>setPreviewDoc(null)} foot={<button className="btn" onClick={()=>setPreviewDoc(null)}>关闭</button>}><div style={{whiteSpace:'pre-wrap',lineHeight:1.7,maxHeight:'60vh',overflow:'auto',fontSize:13}}>{previewDoc.content || '当前文档暂无可预览内容。'}</div></Modal>}
      <OnlinePreviewModal preview={onlinePreview} onClose={()=>setOnlinePreview(null)}/>
      {confirmDoc && <ConfirmModal title="删除知识" msg={<>确认删除 <b style={{color:'var(--ink)'}}>{confirmDoc.name}</b>？删除后将从当前知识库移除。</>} onConfirm={()=>deleteDocument(confirmDoc)} onClose={()=>setConfirmDoc(null)}/>} 
      {confirmKb && <ConfirmModal title="删除个人知识库" msg={<>确认删除个人知识库 <b style={{color:'var(--ink)'}}>{confirmKb.name}</b>？其中的知识将一并删除。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${confirmKb.id}`,{method:'DELETE',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'删除失败'); setConfirmKb(null); setSel(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmKb(null)}/>} 
      {newPersonalOpen && <NewPersonalKBModal onClose={()=>setNewPersonalOpen(false)} onSaved={()=>{setNewPersonalOpen(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
    </div>
  );
}

function NewPersonalKBModal({onClose, onSaved}){
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/kbs`, {method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name:name.trim(),description:description.trim(),type:'personal'})});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '创建失败');
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'个人知识库已创建'})); onSaved?.();
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '创建失败'})); }
    finally { setSaving(false); }
  };
  return <Modal title="新建个人知识库" onClose={onClose} foot={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || !name.trim()} onClick={save}>{saving?'创建中…':'创建'}</button></>}>
    <div className="field"><label>名称<span className="req">*</span></label><input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="如：我的项目笔记"/></div>
    <div className="field"><label>描述</label><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="说明这个个人库的用途"/></div>
    <div className="field-hint">个人知识库仅本人可见，不支持共享和授权。</div>
  </Modal>;
}

/* ============== 管理后台 ============== */
/* ============== Admin: 人员管理 ============== */
function flattenOrgTree(node, parentPath = '') {
  if (!node) return [];
  const path = parentPath ? `${parentPath} / ${node.name}` : node.name;
  return [
    { id: node.id, name: node.name, path },
    ...(node.children || []).flatMap(child => flattenOrgTree(child, path)),
  ];
}

function UsersPanel({orgOptions = [], canManage = false}){
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const filtered = USERS.filter(u => !search || u.name.includes(search) || u.org.includes(search) || u.orgPath.includes(search));
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',marginBottom:20}}>
        <div style={{flex:1}}>
          <div className="h1">人员管理</div>
          <div className="subline">用户归属多组织节点，可绑定多角色 · 来自 LDAP/OIDC 的用户可在「来源」中查看</div>
        </div>
        <input className="search-input" placeholder="搜索姓名 / 组织..." value={search} onChange={e=>setSearch(e.target.value)} style={{marginRight:12}}/>
        {canManage && <button className="btn primary" onClick={()=>{setEditTarget(null); setOpen(true);}}><Icon name="plus" size={12}/> 新增人员</button>}
      </div>

      <div className="admin-table">
        <div className="at-row head" style={{gridTemplateColumns:'1.6fr 1.4fr 1.4fr 90px 120px'}}>
          <div>人员</div><div>归属组织</div><div>角色</div><div>状态</div><div style={{textAlign:'right'}}>操作</div>
        </div>
        {filtered.map(u=>(
          <div key={u.id} className="at-row" style={{gridTemplateColumns:'1.6fr 1.4fr 1.4fr 90px 120px'}}>
            <div className="ppl">
              <div className="avatar">{u.initials}</div>
              <div>
                <div className="nm">{u.name}</div>
                <div className="sub">{u.t}</div>
              </div>
            </div>
            <div>
              <div className="nm-bold">{u.org}</div>
              <div className="path">{u.orgPath}</div>
            </div>
            <div className="role-tags">
              {u.roles.map((r,i)=>(<span key={i} className="role-tag">{r}</span>))}
            </div>
            <div>
              <span className={`status-pill ${u.status}`}><span className="d" style={{width:5,height:5,borderRadius:'50%',background:u.status==='active'?'var(--success)':'var(--ink-4)'}}/>{u.status==='active'?'启用':'停用'}</span>
            </div>
            <div className="actions">
              {canManage && <button onClick={()=>{setEditTarget(u); setOpen(true);}}>编辑</button>}
              {canManage && <button className="danger" onClick={()=>setConfirmDel(u)}>删除</button>}
            </div>
          </div>
        ))}
      </div>

      {open && <UserFormModal target={editTarget} orgOptions={orgOptions} onClose={()=>setOpen(false)} onSaved={()=>{setOpen(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {confirmDel && <ConfirmModal title="删除人员" msg={<>确认删除 <b style={{color:'var(--ink)'}}>{confirmDel.name}</b>？该用户将被立即停用，相关引用与历史保留。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/users/${confirmDel.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('停用失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDel(null)}/>} 
    </>
  );
}

function UserFormModal({target, orgOptions = [], onClose, onSaved}){
  const isEdit = !!target;
  const [name, setName] = useState(target?.name || '');
  const [username, setUsername] = useState(target?.initials?.toLowerCase() || '');
  const [email, setEmail] = useState(target?.email || '');
  const [password, setPassword] = useState('');
  const [orgId, setOrgId] = useState(target?.orgIds?.[0] || '');
  const [status, setStatus] = useState(target?.status || 'active');
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState(isEdit && target ? ROLES.filter(r=>target.roles.includes(r.name)).map(r=>({id:r.id,n:r.name,sub:`${r.users} 人`})) : []);
  const save = async () => {
    if (!name.trim() || !username.trim() || (!isEdit && !orgId)) return;
    setSaving(true);
    try {
      const payload = { displayName:name.trim(), username:username.trim(), email:email.trim() || `${username.trim()}@local.invalid`, orgIds: orgId ? [orgId] : [], roleIds: roles.map(r=>r.id), status, ...(password ? {password} : {}) };
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/users${isEdit ? `/${target.id}` : ''}`, { method:isEdit?'PATCH':'POST', headers:{'Content-Type':'application/json',...apiHeaders()}, body:JSON.stringify(payload) });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'人员已保存'}));
      onSaved?.();
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '保存失败'})); }
    finally { setSaving(false); }
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={isEdit?`编辑人员 · ${target.name}`:'新增人员'} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':isEdit?'保存':'创建'}</button>
      </>
    }>
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
        <div className="field-hint">人员归属多个组织节点时，可见性取并集。可在用户详情中绑定多组织。</div>
      </div>
      <div className="field">
        <label>绑定角色</label>
        <TagPicker placeholder="搜索并选择角色..." items={ROLES.map(r=>({id:r.id,n:r.name,sub:`${r.users} 人 · ${r.builtin?'内置':r.perms.length+' 权限'}`}))} selected={roles} setSelected={setRoles}/>
        <div className="field-hint">角色决定默认权限范围；额外授权可在「权限授权」单独配置。</div>
      </div>
      <div className="field"><label>状态</label><select value={status} onChange={e=>setStatus(e.target.value)}><option value="active">启用</option><option value="disabled">停用</option></select></div>
    </Modal>
  );
}

/* ============== Admin: 角色管理 ============== */
function RolesPanel({canManage = false}){
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',marginBottom:20}}>
        <div style={{flex:1}}>
          <div className="h1">角色管理</div>
          <div className="subline">角色是权限的模板，可绑定多权限码，分配给人员 · 内置角色不可删除</div>
        </div>
        {canManage && <button className="btn primary" onClick={()=>{setEditTarget(null); setOpen(true);}}><Icon name="plus" size={12}/> 新增角色</button>}
      </div>

      <div className="admin-table">
        <div className="at-row head" style={{gridTemplateColumns:'1.4fr 2.6fr 90px 100px 140px'}}>
          <div>角色</div><div>描述</div><div>人员</div><div>类型</div><div style={{textAlign:'right'}}>操作</div>
        </div>
        {ROLES.map(r=>(
          <div key={r.id} className="at-row" style={{gridTemplateColumns:'1.4fr 2.6fr 90px 100px 140px'}}>
            <div>
              <div className="nm-bold">{r.name}</div>
              <div className="role-tags" style={{marginTop:4}}>
                {r.perms.slice(0,3).map((p,i)=>(<span key={i} className="role-tag" style={{fontFamily:'SF Mono,Menlo,monospace'}}>{p}</span>))}
                {r.perms.length>3 && <span className="role-tag" style={{color:'var(--ink-3)'}}>+{r.perms.length-3}</span>}
              </div>
            </div>
            <div style={{color:'var(--ink-2)',fontSize:12,lineHeight:1.5}}>{r.desc}</div>
            <div className="nm-bold" style={{fontVariantNumeric:'tabular-nums'}}>{r.users}</div>
            <div>
              <span className="badge" style={{background: r.builtin?'var(--ink)':'var(--surface-2)', color: r.builtin?'#fff':'var(--ink-3)'}}>{r.builtin?'内置':'自定义'}</span>
            </div>
            <div className="actions">
              {canManage && <button onClick={()=>{setEditTarget(r); setOpen(true);}}>编辑</button>}
              {canManage && !r.builtin && <button className="danger" onClick={()=>setConfirmDel(r)}>删除</button>}
            </div>
          </div>
        ))}
      </div>

      {open && <RoleFormModal target={editTarget} onClose={()=>setOpen(false)} onSaved={()=>{setOpen(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>} 
      {confirmDel && <ConfirmModal title="删除角色" msg={<>确认删除自定义角色 <b style={{color:'var(--ink)'}}>{confirmDel.name}</b>？绑定该角色的 {confirmDel.users} 名人员将失去该角色带来的权限。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/roles/${confirmDel.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDel(null)}/>} 
    </>
  );
}

const ALL_PERMS = [
  {group:'工作台', items:[
    {code:'chat.use',desc:'使用问答对话'},
    {code:'kb.read',desc:'查看本人有权访问的知识库'},
    {code:'kb.read',desc:'查看知识库和知识图谱'},
  ]},
  {group:'知识库', items:[
    {code:'kb.industry.read',desc:'进入行业库管理'},
    {code:'kb.industry.create',desc:'创建行业知识库'},
    {code:'kb.industry.manage',desc:'管理行业知识库'},
    {code:'kb.industry.grant',desc:'管理行业库人员 / 组织 / 角色授权'},
  ]},
  {group:'人员与组织', items:[
    {code:'org.user.read',desc:'查看本组织及下级组织人员'},
    {code:'org.user.manage',desc:'新增/编辑/停用本组织及下级组织人员'},
    {code:'org.read',desc:'查看组织架构'},
    {code:'org.node.create',desc:'新增本组织及下级组织的子组织'},
    {code:'role.read',desc:'查看角色'},
    {code:'role.manage',desc:'管理角色'},
  ]},
  {group:'系统', items:[
    {code:'system.settings.read',desc:'查看系统设置'},
    {code:'system.settings.manage',desc:'管理模型配置'},
    {code:'audit.read',desc:'查看审计日志'},
    {code:'*',desc:'超级权限（含全部）'},
  ]},
];

function RoleFormModal({target, onClose, onSaved}){
  const isEdit = !!target;
  const [picked, setPicked] = useState(isEdit && target ? target.perms : []);
  const [name, setName] = useState(target?.name || '');
  const [description, setDescription] = useState(target?.desc || '');
  const [saving, setSaving] = useState(false);
  const toggle = (code) => {
    if(code==='*'){ setPicked(picked.includes('*') ? [] : ['*']); return; }
    const np = picked.filter(p=>p!=='*');
    setPicked(np.includes(code) ? np.filter(p=>p!==code) : [...np, code]);
  };
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/roles${isEdit ? `/${target.id}` : ''}`, { method:isEdit?'PATCH':'POST', headers:{'Content-Type':'application/json',...apiHeaders()}, body:JSON.stringify({name:name.trim(),description,permissions:picked}) });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      onSaved?.();
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '保存失败'})); }
    finally { setSaving(false); }
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={isEdit?`编辑角色 · ${target.name}`:'新增角色'} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':isEdit?'保存':'创建'}</button>
      </>
    }>
      <div className="field-row">
        <div className="field"><label>角色名称<span className="req">*</span></label><input value={name} onChange={e=>setName(e.target.value)} placeholder="如：合规审核员" disabled={target?.builtin}/></div>
        <div className="field"><label>类型</label><input value={target?.builtin?'内置（不可改）':'自定义'} disabled style={{background:'var(--surface-2)',color:'var(--ink-3)'}}/></div>
      </div>
      <div className="field"><label>描述</label><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="该角色的职责与适用人群"/></div>
      <div className="field">
        <label>权限码（勾选授予）</label>
        <div style={{border:'1px solid var(--line)',borderRadius:7,background:'var(--surface)',maxHeight:260,overflowY:'auto',padding:'8px 12px'}}>
          {ALL_PERMS.map(g=>(
            <div key={g.group} style={{marginBottom:10}}>
              <div style={{fontSize:10.5,color:'var(--ink-3)',textTransform:'uppercase',letterSpacing:.4,fontWeight:600,marginBottom:5}}>{g.group}</div>
              {g.items.map(p=>(
                <label key={p.code} style={{display:'flex',alignItems:'flex-start',padding:'5px 0',cursor:p.code==='*' && target?.builtin ? 'not-allowed':'pointer',opacity: p.code==='*' && target?.builtin ? .5 : 1}}>
                  <input type="checkbox" checked={picked.includes(p.code)} disabled={p.code==='*' && target?.builtin} onChange={()=>toggle(p.code)} style={{marginTop:2,marginRight:8,accentColor:'var(--ink)'}}/>
                  <div style={{flex:1}}>
                    <code style={{background:'var(--surface-2)',padding:'1px 6px',borderRadius:3,fontSize:11,color:'var(--ink)',fontFamily:'SF Mono,Menlo,monospace',marginRight:6}}>{p.code}</code>
                    <span style={{fontSize:11.5,color:'var(--ink-3)'}}>{p.desc}</span>
                  </div>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="field-hint">已选 {picked.filter(p=>p!=='*').length} 条权限{picked.includes('*') && ' · 含超级权限 *'}</div>
      </div>
    </Modal>
  );
}

/* ============== Admin: 行业库管理（含动态新增） ============== */
function IndustryKBPanel({onOpenGrant, canCreate = false}){
  const [openNew, setOpenNew] = useState(false);
  const [adminTarget, setAdminTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',marginBottom:20}}>
        <div style={{flex:1}}>
          <div className="h1">行业库管理</div>
          <div className="subline">动态新增 / 维护行业知识库 · 组织授权包含全部下级组织 · 新员工自动获得符合条件的阅读权限</div>
        </div>
        {canCreate && <button className="btn primary" onClick={()=>setOpenNew(true)}><Icon name="plus" size={12}/> 新建行业库</button>}
      </div>

      <div className="admin-table">
        <div className="at-row head" style={{gridTemplateColumns:'1.8fr 2fr 130px 110px 150px'}}>
          <div>行业库</div><div>描述</div><div>管理员</div><div>授权主体</div><div style={{textAlign:'right'}}>操作</div>
        </div>
        {INDUSTRY_KBS.map(k=>(
          <div key={k.id} className="at-row" style={{gridTemplateColumns:'1.8fr 2fr 130px 110px 150px'}}>
            <div>
              <div className="nm-bold">{k.name}</div>
              <div style={{marginTop:3,display:'flex',alignItems:'center',gap:6}}>
                <span className="badge industry">行业库</span>
                <span style={{fontSize:11,color:'var(--ink-3)'}}>{k.docs} 文档 · 创建于 {k.created}</span>
              </div>
            </div>
            <div style={{color:'var(--ink-2)',fontSize:12,lineHeight:1.5}}>{k.desc}</div>
            <div className="admins" style={{display:'flex'}}>
              {k.admins.map((a,i)=>(<div key={i} className="avatar" title={a.n} style={{width:24,height:24,fontSize:10,border:'1.5px solid var(--surface)',marginLeft:i===0?0:-6, background:'#2C7A7B'}}>{a.i}</div>))}
            </div>
            <div className="nm-bold" style={{fontVariantNumeric:'tabular-nums',color:'var(--ink-2)'}}>{k.grants} 个主体</div>
            <div className="actions">
              {k.canManage && <button onClick={()=>setAdminTarget(k)}>管理员</button>}
              {k.canGrant && <button onClick={()=>onOpenGrant(k)}>授权</button>}
              {k.canDelete && <button className="danger" onClick={()=>setConfirmDel(k)}>删除</button>}
            </div>
          </div>
        ))}
      </div>

      {openNew && <NewIndustryKBModal onClose={()=>setOpenNew(false)} onSaved={()=>{setOpenNew(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>} 
      {adminTarget && <KBAdminModal kb={adminTarget} onClose={()=>setAdminTarget(null)} onSaved={()=>{setAdminTarget(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>} 
      {confirmDel && <ConfirmModal title="删除行业库" msg={<>确认删除 <b style={{color:'var(--ink)'}}>{confirmDel.name}</b>？共 <b>{confirmDel.docs}</b> 份文档将被归档。已授权主体将无法再访问。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${confirmDel.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDel(null)}/>} 
    </>
  );
}

function NewIndustryKBModal({onClose, onSaved}){
  const [admins, setAdmins] = useState([]);
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
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '创建失败'})); }
    finally { setSaving(false); }
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
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
        <TagPicker placeholder="搜索并选择管理员..." items={USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={admins} setSelected={setAdmins}/>
        <div className="field-hint">管理员拥有该库的全部维护权限：上传/编辑/删除文档、设置授权主体。</div>
      </div>
      <div className="warn-strip"><Icon name="alert" size={12}/>创建后可立即上传文档；文档解析和大脑编译由后台异步完成。</div>
    </Modal>
  );
}

function KBAdminModal({kb, onClose, onSaved}){
  const currentAdmins = USERS.filter(u => kb.admins.some(a=>a.n===u.name));
  const [picked, setPicked] = useState(currentAdmins.map(u=>({id:u.id,n:u.name,sub:u.org})));
  const remove = currentAdmins.filter(u => !picked.find(p=>p.id===u.id));
  const save = async () => {
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${kb.id}/admins`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({userIds:picked.map(p=>p.id)})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) { window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '保存失败'})); return; }
    window.dispatchEvent(new CustomEvent('app-toast',{detail:'管理员设置已保存'})); onSaved?.();
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
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
        <TagPicker placeholder="搜索并添加管理员..." items={USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={picked} setSelected={setPicked}/>
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

/* ============== Admin: 模型配置（供应商 + 模型 CRUD） ============== */
function ModelPanel(){
  const [sub, setSub] = useState('models');
  const [openNewPv, setOpenNewPv] = useState(false);
  const [editProvider, setEditProvider] = useState(null);
  const [openNewM, setOpenNewM] = useState<any>(false);
  const [confirmDelPv, setConfirmDelPv] = useState(null);
  const [confirmDelM, setConfirmDelM] = useState(null);
  const [testStates, setTestStates] = useState({});
  const test = async (id) => {
    setTestStates(s=>({...s, [id]:'testing'}));
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/models/${id}/test`,{method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      setTestStates(s=>({...s, [id]:result.status==='passed'?'ok':'failed'}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:result.status==='passed'?'连接测试成功':'连接测试失败'}));
    } catch { setTestStates(s=>({...s, [id]:'failed'})); }
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',marginBottom:18}}>
        <div style={{flex:1}}>
          <div className="h1">模型配置</div>
          <div className="subline">供应商注册 → 模型配置 → 测试连接 → 设为默认；切换 Embedding 需重建索引</div>
        </div>
      </div>
      <div className="subtabs">
        <div className={`subtab ${sub==='models'?'active':''}`} onClick={()=>setSub('models')}>模型配置<span className="n">{MODELS.llm.length+MODELS.embedding.length+MODELS.rerank.length}</span></div>
        <div className={`subtab ${sub==='providers'?'active':''}`} onClick={()=>setSub('providers')}>供应商<span className="n">{PROVIDERS.length}</span></div>
      </div>

      {sub==='models' && (
        <div className="mc">
          <div className="mc-cat llm">
            <div className="mc-cat-head">
              <span className="tag">LLM · 生成</span>
              <h4>大语言模型</h4>
              <span className="hint">用于答案生成与查询改写</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({kind:'llm'})}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {MODELS.llm.map(m=>{
              const state = testStates[m.id] || (m.tested?'ok':'idle');
              if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span><span>上下文 {m.ctx}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({kind:'llm',target:m})}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'llm'})}>删除</button>
                </div>
              );
            })}
          </div>

          <div className="mc-cat embed">
            <div className="mc-cat-head">
              <span className="tag">EMBEDDING · 向量</span>
              <h4>嵌入模型</h4>
              <span className="hint">每库绑定 · 切换需全量重建索引</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({kind:'embedding'})}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {MODELS.embedding.map(m=>{
              const state = testStates[m.id] || (m.tested?'ok':'idle');
              if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span><span>{m.dim}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({kind:'embedding',target:m})}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'embedding'})}>删除</button>
                </div>
              );
            })}
            <div className="warn-strip">
              <Icon name="alert" size={12}/>
              切换 Embedding 模型将触发异步全量重建索引，期间查询降级为关键词检索。
            </div>
          </div>

          <div className="mc-cat rerank">
            <div className="mc-cat-head">
              <span className="tag">RERANKER · 重排</span>
              <h4>重排模型</h4>
              <span className="hint">混合检索后精排 · 提升引用质量</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({kind:'rerank'})}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {MODELS.rerank.map(m=>{
              const state = testStates[m.id] || (m.tested?'ok':'idle');
              if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({kind:'rerank',target:m})}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'rerank'})}>删除</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sub==='providers' && (
        <>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            <button className="btn primary" onClick={()=>setOpenNewPv(true)}><Icon name="plus" size={12}/> 新增供应商</button>
          </div>
          <div className="admin-table">
            <div className="at-row head" style={{gridTemplateColumns:'1.4fr 2.4fr 1fr 1fr 130px'}}>
              <div>名称</div><div>Base URL</div><div>类型</div><div>API Key</div><div style={{textAlign:'right'}}>操作</div>
            </div>
            {PROVIDERS.map(p=>(
              <div key={p.id} className="at-row" style={{gridTemplateColumns:'1.4fr 2.4fr 1fr 1fr 130px'}}>
                <div>
                  <div className="nm-bold">{p.name}</div>
                  <div className="path" style={{marginTop:2}}>{p.note}</div>
                </div>
                <div className="path" style={{fontFamily:'SF Mono,Menlo,monospace'}}>{p.url}</div>
                <div>
                  <span className="badge" style={{background: p.kind==='gateway'?'#EDE7F8':p.kind==='selfhost'?'var(--kb-industry-soft)':'var(--surface-2)', color: p.kind==='gateway'?'#5D429A':p.kind==='selfhost'?'var(--kb-industry)':'var(--ink-3)'}}>
                    {p.kind==='gateway'?'网关':p.kind==='selfhost'?'自托管':'外部API'}
                  </span>
                </div>
                <div style={{fontFamily:'SF Mono,Menlo,monospace',fontSize:11.5,color:'var(--ink-3)'}}>{p.keyMask}</div>
                <div className="actions">
                  <button onClick={()=>setEditProvider(p)}>编辑</button>
                  <button className="danger" onClick={()=>setConfirmDelPv(p)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {(openNewPv || editProvider) && <NewProviderModal target={editProvider} onClose={()=>{setOpenNewPv(false);setEditProvider(null)}} onSaved={()=>{setOpenNewPv(false);setEditProvider(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {openNewM && <NewModelModal kind={openNewM.kind} target={openNewM.target} onClose={()=>setOpenNewM(false)} onSaved={()=>{setOpenNewM(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {confirmDelPv && <ConfirmModal title="删除供应商" msg={<>确认删除供应商 <b style={{color:'var(--ink)'}}>{confirmDelPv.name}</b>？引用此供应商的所有模型将变为不可用状态，需先迁移。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers/${confirmDelPv.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelPv(null)}/>} 
      {confirmDelM && <ConfirmModal title="删除模型" msg={<>确认删除模型 <b style={{color:'var(--ink)'}}>{confirmDelM.name}</b>？知识库中绑定此模型的将需要回退到默认。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/models/${confirmDelM.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelM(null)}/>} 
    </>
  );
}

function NewProviderModal({target, onClose, onSaved}){
  const [kind, setKind] = useState(target?.kind || 'gateway');
  const [name, setName] = useState(target?.name || ''); const [baseUrl, setBaseUrl] = useState(target?.url || ''); const [apiKey, setApiKey] = useState(''); const [note, setNote] = useState(''); const [saving, setSaving] = useState(false);
  const save = async () => { if (!name.trim() || !baseUrl.trim()) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name,kind,baseUrl,defaultParams:{note},...(apiKey ? {apiKey} : {})})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'供应商已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'保存失败'}));} finally{setSaving(false);} };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={target ? `编辑供应商 · ${target.name}` : '新增供应商'} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存'}</button>
      </>
    }>
      <div className="field"><label>名称<span className="req">*</span></label><input value={name} onChange={e=>setName(e.target.value)} placeholder="如：内部自建 vLLM"/></div>
      <div className="field"><label>类型<span className="req">*</span></label>
        <select value={kind} onChange={e=>setKind(e.target.value)}>
          <option value="gateway">网关（统一代理多个上游）</option>
          <option value="selfhost">自托管（TEI / vLLM / Ollama 等）</option>
          <option value="external">外部API（OpenAI / DeepSeek 等）</option>
        </select>
      </div>
      <div className="field"><label>Base URL<span className="req">*</span></label><input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://..."/></div>
      <div className="field"><label>API Key</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={kind==='selfhost'?'(自托管通常不需要)':'sk-...'}/></div>
      <div className="field"><label>备注</label><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="该供应商用途、限速、协议说明"/></div>
    </Modal>
  );
}

function NewModelModal({kind, target, onClose, onSaved}){
  const label = kind==='llm' ? '大语言模型' : kind==='embedding' ? '嵌入模型' : '重排模型';
  const [modelName, setModelName] = useState(target?.modelName || target?.name || ''); const [providerId, setProviderId] = useState(target?.providerId || ''); const [contextLen, setContextLen] = useState(String(target?.contextLen || 8192)); const [dimensions, setDimensions] = useState(target?.dimensions ? String(target.dimensions) : ''); const [isDefault, setIsDefault] = useState(Boolean(target?.isDefault ?? target?.default)); const [saving, setSaving] = useState(false);
  const save = async () => { if (!modelName.trim() || !providerId) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/models${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({kind,modelName,providerId,contextLen,dimensions,isDefault})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'模型已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'保存失败'}));} finally{setSaving(false);} };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={`${target ? '编辑' : '新增'}${label}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存'}</button>
      </>
    }>
      <div className="field"><label>模型名称<span className="req">*</span></label><input value={modelName} onChange={e=>setModelName(e.target.value)} placeholder="如：qwen3-max / bge-m3 / bge-reranker-v2-m3"/></div>
      <div className="field"><label>供应商<span className="req">*</span></label>
        <select value={providerId} onChange={e=>setProviderId(e.target.value)}><option value="">选择已注册的供应商…</option>{PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {kind==='llm' && (
        <div className="field-row">
          <div className="field"><label>上下文长度</label><input value={contextLen} onChange={e=>setContextLen(e.target.value)} placeholder="如：8192"/></div>
          <div className="field"><label>最大输出</label><input placeholder="如：8K"/></div>
        </div>
      )}
      {kind==='embedding' && (
        <div className="field-row">
          <div className="field"><label>向量维度<span className="req">*</span></label><input value={dimensions} onChange={e=>setDimensions(e.target.value)} placeholder="如：1024"/></div>
          <div className="field"><label>批处理上限</label><input placeholder="如：64"/></div>
        </div>
      )}
      <div className="field">
        <label>默认参数（JSON）</label>
        <textarea placeholder='{"temperature": 0.7, "top_p": 0.9}' style={{fontFamily:'SF Mono,Menlo,monospace'}}/>
      </div>
      <div className="field">
        <label>设为默认</label>
        <select value={isDefault?'yes':'no'} onChange={e=>setIsDefault(e.target.value==='yes')}><option value="no">否</option><option value="yes">是（将替换现有默认）</option></select>
      </div>
    </Modal>
  );
}

/* ============== AdminScreen（汇总） ============== */
function AdminScreen({onOpenGrant, onManageKb, initialTab, capabilities = []}){
  const [tab, setTab] = useState(initialTab || 'org');
  useEffect(()=>{
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [grantKb, setGrantKb] = useState(()=>INDUSTRY_KBS[0]?.id || '');
  // 组织树 state：支持无限层级新增
  const [orgTree, setOrgTree] = useState(()=>{
    const init = (n) => ({...n, id: n.id || ('on_' + Math.random().toString(36).slice(2,9)), children: (n.children||[]).map(init)});
    return ORG_TREE ? init(ORG_TREE) : null;
  });
  // 展开状态受控（新增子组织后自动展开父节点）
  const [expandedIds, setExpandedIds] = useState(()=>{
    const s = new Set();
    const walk = (n)=>{ if(n.expanded) s.add(n.id); (n.children||[]).forEach(walk); };
    if (orgTree) walk(orgTree);   // 注意：walk id 化后的树，保证 id 与渲染一致
    return s;
  });
  const [adminModal, setAdminModal] = useState(null); // 设置管理员的节点
  const [addModal, setAddModal] = useState(null);     // 新增子组织的父节点
  const orgOptions = useMemo(() => flattenOrgTree(orgTree), [orgTree]);
  const tabRules = [
    {k:'org', l:'组织架构', ic:'users', permission:'org.read'},
    {k:'users', l:'人员管理', ic:'user', permission:'org.user.read'},
    {k:'roles', l:'角色管理', ic:'shield', permission:'role.read'},
    {k:'industry', l:'行业库管理', ic:'book', permission:'kb.industry.read'},
    {k:'grant', l:'权限授权', ic:'shield', permission:'kb.industry.grant'},
    {k:'model', l:'模型配置', ic:'model', permission:'system.settings.manage'},
    {k:'audit', l:'审计日志', ic:'history', permission:'audit.read'},
  ];
  const availableTabs = tabRules.filter(item => hasCapability(item.permission, capabilities)).map(item => item.k);
  useEffect(() => {
    if (availableTabs.length && !availableTabs.includes(tab)) setTab(availableTabs[0]);
  }, [availableTabs.join(','), tab]);

  const toggleNode = (id) => setExpandedIds(s=>{ const ns = new Set(s); ns.has(id) ? ns.delete(id) : ns.add(id); return ns; });

  const addChildOrg = async (parentId, name) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name, parentId: parentId || null }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const created = result.organization;
      if (!created) throw new Error('接口未返回新组织');
      setExpandedIds(s=>new Set(s).add(parentId));   // 确保父节点展开，新节点立即可见
      setOrgTree(t=>{
        const rec = (n) => {
          if(n.id === parentId){
            return {...n, children: [...(n.children||[]), {...created, children: []}]};
          }
          return {...n, children: (n.children||[]).map(rec)};
        };
        return parentId ? rec(t) : {...created, children: []};
      });
      window.dispatchEvent(new CustomEvent('app-toast', {detail:`组织「${created.name}」已保存` }));
      return true;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:`组织保存失败：${error.message || '请稍后重试'}` }));
      return false;
    }
  };
  const updateOrg = (id, updater) => setOrgTree(tree => {
    const walk = (node) => node?.id === id ? updater(node) : ({...node, children:(node.children||[]).map(walk)});
    return tree ? walk(tree) : tree;
  });
  const activateKb = async (node) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/knowledge-base/activate`, {method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({})});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '激活失败');
      const kb = result.knowledgeBase;
      updateOrg(node.id, current => ({...current, kbs:[kb.id], knowledgeBase:kb}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:`「${node.name}」组织库已激活`}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '激活失败'})); }
  };
  const deactivateKb = async (node) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/knowledge-base/deactivate`, {method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '去激活失败');
      updateOrg(node.id, current => ({...current, kbs:[], knowledgeBase:null}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:`「${node.name}」组织库已去激活`}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '去激活失败'})); }
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div className="admin">
      <div className="admin-side">
        <h5>管理后台</h5>
        <div className="a-nav">
          <div className="nav-section" style={{padding:'8px 12px',margin:0,fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>组织与人员</div>
          {tabRules.slice(0,3).filter(it => hasCapability(it.permission, capabilities)).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
          <div className="nav-section" style={{padding:'8px 12px',margin:'12px 0 0',fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>知识与权限</div>
          {tabRules.slice(3,5).filter(it => hasCapability(it.permission, capabilities)).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
          <div className="nav-section" style={{padding:'8px 12px',margin:'12px 0 0',fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>系统</div>
          {tabRules.slice(5).filter(it => hasCapability(it.permission, capabilities)).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-main">
        {tab==='org' && (
          <>
            <div style={{display:'flex',alignItems:'flex-start',marginBottom:20}}>
              <div style={{flex:1}}>
                <div className="h1">组织架构</div>
                <div className="subline">支持无限层级 · 组织树变更会自动刷新用户可见库缓存 · 每一级组织都可设置知识库管理员</div>
              </div>
              {hasCapability('*', capabilities) && <button className="btn primary" onClick={()=>setAddModal(orgTree || {id:null,name:'根节点'})}><Icon name="plus" size={12}/> 新增一级组织</button>}
            </div>
            <div className="org-tree">
              {orgTree ? <OrgNode node={orgTree} depth={0} expandedIds={expandedIds} onToggle={toggleNode}
                onAddChild={(n)=>setAddModal(n)} onSetAdmin={(n)=>setAdminModal(n)} onActivateKb={activateKb} onDeactivateKb={deactivateKb} onManageKb={onManageKb}/>
                : <div style={{padding:30,color:'var(--ink-3)'}}>暂无组织节点，请先新增一级组织。</div>}
            </div>
          </>
        )}
        {tab==='users' && <UsersPanel orgOptions={orgOptions} canManage={hasCapability('org.user.manage', capabilities)}/>} 
        {tab==='roles' && <RolesPanel canManage={hasCapability('role.manage', capabilities)}/>} 
        {tab==='industry' && <IndustryKBPanel canCreate={hasCapability('kb.industry.create', capabilities)} onOpenGrant={(k)=>{setGrantKb(k.id); setTab('grant');}}/>}
        {tab==='grant' && <GrantPanel kbId={grantKb} setKbId={setGrantKb}/>}
        {tab==='model' && <ModelPanel/>}
        {tab==='audit' && (
          <>
            <div className="h1">审计日志</div>
            <div className="subline">查询 · 知识变更 · 权限变更 · 大脑编译记录 · Dream Cycle · 越权拦截 · 留存 ≥ 1 年</div>
            <div className="audit">
              {AUDIT.map((a,i)=>(
                <div key={i} className="audit-row">
                  <div className="when">{a.when}</div>
                  <div className="what">{a.what}</div>
                  <div className="actor">{a.actor}</div>
                </div>
              ))}
            </div>
          </>
        )}

          {adminModal && <OrgAdminModal node={adminModal} onClose={()=>setAdminModal(null)} onSaved={()=>{setAdminModal(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>} 
        {addModal && <AddOrgModal parent={addModal} onAdd={async (name)=>{if (await addChildOrg(addModal.id, name)) setAddModal(null);}} onClose={()=>setAddModal(null)}/>} 
      </div>
    </div>
  );
}

/* 新增子组织弹窗（支持无限层级） */
function AddOrgModal({parent, onAdd, onClose}){
  const [name, setName] = useState('');
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <Modal title={parent.id ? `新增子组织 · ${parent.name}` : '新增一级组织'} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!name.trim()} onClick={()=>onAdd(name.trim())}>创建</button>
      </>
    }>
      <div className="field">
        <label>组织名称<span className="req">*</span></label>
        <input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="如：合规三组 / 华东分部" onKeyDown={e=>{if(e.key==='Enter' && name.trim()) onAdd(name.trim());}}/>
      </div>
      <div style={{padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.6}}>
        <b style={{color:'var(--ink)'}}>继承规则</b>：{parent.id ? `新组织自动挂到「${parent.name}」之下，其成员自动继承${parent.name === '集团总部' ? '全部组织库' : `「${parent.name}」及其上级`}的可见范围；` : '新组织将作为组织树根节点；'}可在创建后为该组织单独设置知识库管理员。
      </div>
    </Modal>
  );
}

/* 组织节点管理员设置（每一级组织都可设置；建库后自动生效） */
function OrgAdminModal({node, onClose, onSaved}){
  const pickedInit = (node.admins||[]).map(nm => USERS.find(u=>u.name===nm)).filter(Boolean).map(u=>({id:u.id,n:u.name,sub:u.org}));
  const [picked, setPicked] = useState(pickedInit);
  const hasKb = node.kbs && node.kbs.length>0;
  const save = async () => {
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/admins`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({userIds:picked.map(p=>p.id)})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) { window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '保存失败'})); return; }
    window.dispatchEvent(new CustomEvent('app-toast',{detail:'组织管理员设置已保存'})); onSaved?.();
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
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
        <TagPicker placeholder="搜索并选择管理员..." items={USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={picked} setSelected={setPicked}/>
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

/* GrantPanel extracted for reuse + selectedKb pre-fill */
function GrantPanel({kbId, setKbId}){
  const [grantTab, setGrantTab] = useState('user');
  const [subjectId, setSubjectId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const addGrant = async () => {
    if (!kbId || !subjectId) return;
    const expiry = expiresAt ? new Date(Date.now() + Number(expiresAt) * 86400000).toISOString() : undefined;
    const response = await fetch(`${API_BASE_URL}/api/v1/admin/grants`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({kbId,subjectType:grantTab,subjectId,expiresAt:expiry})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) { window.dispatchEvent(new CustomEvent('app-toast',{detail:result.message || '授权失败'})); return; }
    setSubjectId(''); window.dispatchEvent(new CustomEvent('app-toast',{detail:'授权已保存'})); window.dispatchEvent(new CustomEvent('app-data-refresh'));
  };
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <>
      <div className="h1">行业库授权</div>
      <div className="subline">支持人员 / 角色 / 组织三类主体；组织授权包含全部下级组织，新增人员会动态获得权限</div>
      <div className="grant">
        <h6>目标库</h6>
        <div className="g-input">
          <select value={kbId} onChange={e=>setKbId && setKbId(e.target.value)}>
            {INDUSTRY_KBS.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </div>

        <h6>添加授权</h6>
        <div className="g-tabs">
          {[{k:'user',l:'人员'},{k:'role',l:'角色'},{k:'org',l:'组织'}].map(g=>(
            <button key={g.k} className={grantTab===g.k?'on':''} onClick={()=>setGrantTab(g.k)}>{g.l}</button>
          ))}
        </div>
        <div className="g-input">
          <select value={subjectId} onChange={e=>setSubjectId(e.target.value)}>
            <option value="">选择主体…</option>
            {grantTab==='user' && USERS.filter(u=>u.status!=='disabled').map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
            {grantTab==='role' && ROLES.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            {grantTab==='org' && flattenOrgTree(ORG_TREE).map(o=><option key={o.id} value={o.id}>{o.path}</option>)}
          </select>
          <select value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}>
            <option value="">永久</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">1 年</option>
          </select>
          <button className="btn primary" style={{padding:'7px 14px'}} onClick={addGrant}><Icon name="plus" size={12}/> 添加</button>
        </div>

        <div className="g-list">
          <h6>当前授权</h6>
          {GRANTS.filter(g=>g.kbId===kbId).map((g,i)=>(
            <div key={i} className="g-row">
              <div className="subj">
                {g.avatar ? <div className="avatar">{g.avatar}</div> : <Icon name={g.type==='role'?'users':'folder'} size={14} color="var(--ink-3)"/>}
                <span>{g.subj}</span>
                <span style={{fontSize:11,color:'var(--ink-4)',marginLeft:6}}>· {g.scope}</span>
              </div>
                <span className="type-stamp">{g.type==='user'?'人员':g.type==='role'?'角色':'组织'}</span>
              <span className="exp">至 {g.exp}</span>
              <button className="x" onClick={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/grants/${g.id}`,{method:'DELETE',headers:apiHeaders()}); if(response.ok) window.dispatchEvent(new CustomEvent('app-data-refresh'));}}>×</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function OrgNode({node, depth, expandedIds, onToggle, onAddChild, onSetAdmin, onActivateKb, onDeactivateKb, onManageKb}){
  const open = expandedIds.has(node.id);
  const hasChildren = node.children && node.children.length>0;
  const isRoot = depth===0;
  const hasKb = node.kbs && node.kbs.length>0;
  const adminNames = node.admins || [];
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  return (
    <div>
      <div className={`org-node ${isRoot?'root':''}`} onClick={()=>onToggle(node.id)}>
        {hasChildren ? (
          <Icon name="chevron" size={11} className={`ic ${open?'open':''}`}/>
        ) : (
          <span style={{width:11,display:'inline-block'}}/>
        )}
        <span className="nm">{node.name}</span>
        {adminNames.length>0 && <span style={{fontSize:11,color:'var(--ink-3)'}}>· {adminNames.join('、')}</span>}
        {hasKb ? <span className="tag">组织库已激活</span> : <span className="tag" style={{color:'var(--ink-4)',background:'var(--surface-2)'}}>未激活组织库</span>}
        <span className="ct">{hasChildren?`${node.children.length} 个下级`:'—'}</span>
        <span className="org-acts" onClick={e=>e.stopPropagation()}>
          {node.canSetAdmin && <button className="act" onClick={()=>onSetAdmin(node)} title="设置本组织的知识库管理员">管理员</button>}
          {node.canManage && (hasKb ? <>
            <button className="act" onClick={()=>onManageKb?.(node.knowledgeBase?.id)} title="打开该组织知识库">管理知识库</button>
            <button className="act danger" onClick={()=>onDeactivateKb?.(node)} title="停用该组织知识库">去激活</button>
          </> : <button className="act" onClick={()=>onActivateKb?.(node)} title="创建并启用该组织知识库">激活组织库</button>)}
          {node.canCreateChild && <button className="act" onClick={()=>onAddChild(node)} title="在此组织下新增子组织">+ 子组织</button>}
        </span>
      </div>
      {open && hasChildren && (
        <div className="org-children">
          {node.children.map((c,i)=>(
            <OrgNode key={c.id||i} node={c} depth={depth+1} expandedIds={expandedIds} onToggle={onToggle} onAddChild={onAddChild} onSetAdmin={onSetAdmin} onActivateKb={onActivateKb} onDeactivateKb={onDeactivateKb} onManageKb={onManageKb}/>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============== 知识图谱 ============== */
function KnowledgeGraphScreen(){
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`${API_BASE_URL}/api/v1/knowledge-graph`, {headers: apiHeaders()})
      .then(async response => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.message || `API ${response.status}`); return payload; })
      .then(payload => { if (active) { setGraph(payload); setError(''); } })
      .catch(reason => { if (active) setError(reason.message || '知识图谱加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) return <div className="graph-page"><div className="graph-state">正在构建你的知识图谱…</div></div>;
  if (error) return <div className="graph-page"><div className="graph-state error">{error}</div></div>;
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleNodes = normalizedQuery ? nodes.filter(node => node.label.toLowerCase().includes(normalizedQuery)) : nodes;
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const filteredEdges = edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const width = 1100;
  const height = 650;
  const columns = {knowledge_base: 160, document: 520, concept: 880};
  const typed = {knowledge_base: nodes.filter(n=>n.type==='knowledge_base'), document: nodes.filter(n=>n.type==='document'), concept: nodes.filter(n=>n.type==='concept')};
  const positions = new Map();
  Object.entries(typed).forEach(([type, list]) => list.forEach((node, index) => positions.set(node.id, {x: columns[type], y: 50 + ((index + 1) * (height - 90) / (list.length + 1))})));
  const selectedNode = nodes.find(node => node.id === selected);
  const connectedEdges = selected ? edges.filter(edge => edge.source === selected || edge.target === selected) : [];
  const connectedIds = new Set(connectedEdges.flatMap(edge => [edge.source, edge.target]));
  const nodeColor = {knowledge_base:'#8b5cf6', document:'#2563eb', concept:'#c47a18'};
  return (
    <div className="graph-page">
      <div className="graph-head">
        <div><div className="h1">知识图谱</div><div className="subline">展示你有权访问的已发布知识：知识库、文档、章节主题和文档间关联。</div></div>
        <div className="graph-stats"><span>{graph?.stats?.documents || 0} 文档</span><span>{graph?.stats?.concepts || 0} 个主题</span><span>{graph?.stats?.relations || 0} 条关系</span></div>
      </div>
      <div className="graph-toolbar"><div className="graph-search"><Icon name="search" size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索文档或主题"/></div><span className="graph-hint">关系均保留来源文档证据；仅展示当前账号可见内容</span></div>
      <div className="graph-layout">
        <div className="graph-canvas">
          {nodes.length === 0 ? <div className="graph-state">当前没有可生成图谱的已发布知识。</div> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="个人知识图谱">
            <defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b9b5ae"/></marker></defs>
            {filteredEdges.map(edge => { const a=positions.get(edge.source); const b=positions.get(edge.target); if(!a||!b) return null; const active=!selected || edge.source===selected || edge.target===selected; return <g key={edge.id} opacity={active?1:.12}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={edge.type==='related_to'?'#c47a18':'#b9b5ae'} strokeWidth={Math.min(3, 1 + edge.weight/3)} markerEnd="url(#graph-arrow)"/><title>{edge.type==='contains'?'包含':edge.type==='mentions'?'提及':'共同主题'} · 权重 {edge.weight}</title></g>; })}
            {visibleNodes.map(node => { const p=positions.get(node.id); if(!p) return null; const active=!selected || node.id===selected || connectedIds.has(node.id); return <g key={node.id} transform={`translate(${p.x},${p.y})`} opacity={active?1:.22} onClick={()=>setSelected(node.id)} className="graph-node"><circle r={node.type==='knowledge_base'?22:node.type==='document'?17:13} fill={nodeColor[node.type]} stroke={node.id===selected?'#111827':'white'} strokeWidth={node.id===selected?3:2}/><text x="0" y="34" textAnchor="middle">{node.label.length>18?`${node.label.slice(0,18)}…`:node.label}</text></g>; })}
          </svg>}
        </div>
        <aside className="graph-detail">
          {selectedNode ? <><div className="graph-detail-type" style={{color:nodeColor[selectedNode.type]}}>{selectedNode.type==='knowledge_base'?'知识库':selectedNode.type==='document'?'文档':'主题'}</div><h3>{selectedNode.label}</h3><p>{selectedNode.type==='document' ? '该节点来自可见知识库中的已发布文档。' : selectedNode.type==='concept' ? '该主题由章节、标题、显式引用和文档内容共同提取。' : '该节点表示一个可见知识库。'}</p><div className="graph-related"><b>关联关系</b>{connectedEdges.slice(0,12).map(edge=><div key={edge.id}><span>{edge.type==='contains'?'包含':edge.type==='mentions'?'提及':'共同主题'}</span> · {nodes.find(node=>node.id===(edge.source===selected?edge.target:edge.source))?.label || '—'}</div>)}</div></> : <><h3>点击节点查看详情</h3><p>图谱不会显示无权限知识。点击文档或主题节点，可查看它与其他知识的关联。</p></>}
        </aside>
      </div>
      <div className="graph-legend"><span><i style={{background:nodeColor.knowledge_base}}/>知识库</span><span><i style={{background:nodeColor.document}}/>文档</span><span><i style={{background:nodeColor.concept}}/>主题 / 实体</span><span>线条粗细代表关联出现次数</span></div>
    </div>
  );
}

/* ============== App 入口 ============== */
function LoginScreen({ onSubmit, error, loading }) {
  const [username, setUsername] = useState('CY');
  const [password, setPassword] = useState('');
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
        <div style={{fontSize:24,fontWeight:600,marginBottom:8}}>LLM Wiki</div>
        <div style={{color:'#756f66',fontSize:14,marginBottom:28}}>登录你的企业知识大脑</div>
        <label style={{display:'block',fontSize:13,marginBottom:6}}>账号</label>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>密码</label>
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" autoFocus style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:18}} />
        {error && <div style={{color:'#b42318',fontSize:13,marginBottom:14}}>{error}</div>}
        <button type="submit" disabled={loading || !username || !password} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}

function App(){

  const [dbData, setDbData] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [authState, setAuthState] = useState('checking');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const loadAdminData = async (token) => {
    const res = await fetch(`${API_BASE_URL}/api/v1/admin/data`, { headers: { Authorization: `Bearer ${token}` } });
    let d;
    if (res.ok) {
      d = await res.json();
    } else if (res.status === 403) {
      const sessionRes = await fetch(`${API_BASE_URL}/api/v1/session/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
      if (!sessionRes.ok) throw new Error(`API ${sessionRes.status}`);
      const session = await sessionRes.json();
      d = { ...session, kbs: session.kbs || [], users: [], orgs: [], roles: [], grants: [], providers: [], models: [], audit: [] };
    } else {
      throw new Error(`API ${res.status}`);
    }
    CAPABILITIES = Array.isArray(d.capabilities) ? d.capabilities : [];
    KNOWLEDGE_BASES = d.kbs.map((kb: any) => ({
      id: kb.id,
      type: kb.type,
      name: kb.name,
      desc: kb.description,
      docs: kb.documentCount ?? kb.docs?.length ?? 0,
      canWrite: Boolean(kb.canWrite),
      canManage: Boolean(kb.canManage),
      canGrant: Boolean(kb.canGrant),
      canDelete: Boolean(kb.canDelete),
      admins: kb.admins?.map((a: any) => ({ n: a.user?.displayName, i: a.user?.username })) || [],
      visibility: kb.type === 'personal' ? '仅自己' : kb.type === 'org' ? '组织继承' : '按授权',
      owner: kb.ownerUser?.displayName || kb.ownerUser?.username || '系统'
    }));
    USERS = (d.users || []).map((u: any) => {
      const memberships = u.orgs || [];
      const roles = (u.roles || []).map((item: any) => item.role?.name).filter(Boolean);
      const orgNodes = memberships.map((item: any) => item.orgNode).filter(Boolean);
      return {
        id: u.id,
        name: u.displayName || u.username,
        initials: u.username,
        email: u.email,
        t: u.source === 'manual' ? '手动创建' : (u.source || '系统用户'),
        roles: roles.length ? roles : ['普通用户'],
        status: u.status || 'active',
        org: orgNodes.map((node: any) => node.name).join('、') || '未分配组织',
        orgPath: orgNodes.map((node: any) => node.path || node.name).join('、') || '—',
        orgIds: orgNodes.map((node: any) => node.id),
      };
    });
    ROLES = (d.roles || []).map((role: any) => ({ ...role, desc: role.description || '', perms: Array.isArray(role.permissions) ? role.permissions : (role.perms || []) }));
    // 行业库管理页只显示本人实际负责的库；d.kbs 仍保留所有“可阅读”知识库，
    // 供知识库页和问答范围使用。
    INDUSTRY_KBS = (d.managedIndustryKbs || []).filter((kb: any) => kb.type === 'industry').map((kb: any) => ({
      ...kb,
      desc: kb.description || '',
      docs: kb.documentCount || 0,
      created: kb.createdAt ? new Date(kb.createdAt).toLocaleDateString('zh-CN') : '—',
      admins: (kb.admins || []).map((a: any) => ({ n: a.user?.displayName || a.user?.username, i: a.user?.username })),
      grants: (d.grants || []).filter((grant: any) => grant.kbId === kb.id).length,
      canManage: Boolean(kb.canManage),
      canGrant: Boolean(kb.canGrant),
      canDelete: Boolean(kb.canDelete),
    }));
    GRANTS = (d.grants || []).map((grant: any) => {
      const subject = grant.subjectType === 'user' ? (USERS.find(u => u.id === grant.subjectId)?.name || grant.subjectId) : grant.subjectType === 'role' ? (ROLES.find(r => r.id === grant.subjectId)?.name || grant.subjectId) : (d.orgs || []).find((o: any) => o.id === grant.subjectId)?.name || grant.subjectId;
      return { ...grant, subj: subject, type: grant.subjectType, exp: grant.expiresAt ? new Date(grant.expiresAt).toLocaleDateString('zh-CN') : '永久', scope: grant.subjectType };
    });
    PROVIDERS = (d.providers || []).map((provider: any) => ({ ...provider, url: provider.baseUrl, note: provider.defaultParams ? JSON.stringify(provider.defaultParams) : '', kind: provider.kind || 'external' }));
    MODELS = { llm: [], embedding: [], rerank: [] };
    (d.models || []).forEach((model: any) => {
      const kind = ['llm', 'embedding', 'rerank'].includes(model.kind) ? model.kind : 'llm';
      (MODELS[kind] ||= []).push({ ...model, name: model.modelName, provider: model.provider?.name || '—', ctx: `${Math.round((model.contextLen || 0) / 1024) || model.contextLen}K`, dim: model.dimensions ? `${model.dimensions} 维` : '', default: model.isDefault, tested: model.testStatus === 'passed' });
    });
    AUDIT = (d.audit || []).map((item: any) => ({ ...item, when: new Date(item.when).toLocaleString('zh-CN'), what: item.action, actor: item.actor }));
    setCurrentUser(d.user || null);
    if (d.orgs?.length) {
      const nodes = d.orgs.map((node: any) => ({ ...node, kbs: (node.kbs || []).map((kb: any) => kb.id), knowledgeBase: (node.kbs || [])[0] || null, admins: (node.admins || []).map((a: any) => a.user?.displayName || a.user?.username).filter(Boolean), children: [] }));
      const byId = Object.fromEntries(nodes.map((node: any) => [node.id, node]));
      for (const node of nodes) {
        const parent = node.parentId ? byId[node.parentId] : nodes
          .filter((candidate: any) => candidate.id !== node.id && node.path.startsWith(`${candidate.path}/`))
          .sort((a: any, b: any) => b.path.length - a.path.length)[0];
        if (parent) parent.children.push(node);
      }
      const root = nodes.find((node: any) => !nodes.some((candidate: any) => candidate.children.includes(node))) || nodes[0];
      ORG_TREE = root ? { ...root, expanded: true } : ORG_TREE;
    } else ORG_TREE = null;
    try {
      const conversationsResponse = await fetch(`${API_BASE_URL}/api/v1/conversations`, { headers: { Authorization: `Bearer ${token}` } });
      CONVERSATIONS = conversationsResponse.ok ? await conversationsResponse.json() : [];
    } catch { CONVERSATIONS = []; }
    setDbData(d);
  };

  useEffect(() => {
    const token = window.localStorage.getItem('llmwiki_token');
    if (!token) {
      setAuthState('loggedOut');
      return;
    }
    loadAdminData(token)
      .then(() => setAuthState('loggedIn'))
      .catch(() => {
        window.localStorage.removeItem('llmwiki_token');
        setAuthState('loggedOut');
      });
  }, []);

  useEffect(() => {
    const refresh = () => {
      const token = window.localStorage.getItem('llmwiki_token');
      if (token) void loadAdminData(token);
    };
    window.addEventListener('app-data-refresh', refresh);
    return () => window.removeEventListener('app-data-refresh', refresh);
  }, []);

  const handleLogin = async (username, password) => {
    setLoginLoading(true);
    setLoginError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '登录失败');
      window.localStorage.setItem('llmwiki_token', result.token);
      await loadAdminData(result.token);
      setAuthState('loggedIn');
    } catch (error) {
      setLoginError(error.message || '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    window.localStorage.removeItem('llmwiki_token');
    setCurrentUser(null);
    setDbData(null);
    setLoginError('');
    setAuthState('loggedOut');
    setScreen('chat');
    window.history.replaceState({}, '', '/');
  };

  


  const [screen, setScreen] = useState(() => typeof window !== 'undefined' && window.location.pathname.startsWith('/admin') ? 'admin' : 'chat');
  const [adminTab, setAdminTab] = useState('org');
  const [libraryKbId, setLibraryKbId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  useEffect(()=>{
    const h = (e)=>{
      setToast(e.detail);
      if(toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(()=>setToast(null), 4000);
    };
    window.addEventListener('app-toast', h);
  return ()=>window.removeEventListener('app-toast', h);
  },[]);

  const titles = {
    chat: {t:'对话', s:`你的大脑 · ${KNOWLEDGE_BASES.length} 个可见知识库`},
    libs: {t:'知识库', s:`${KNOWLEDGE_BASES.length} 个知识库`},
    graph: {t:'知识图谱', s:'你的知识 · 可见知识关系'},
    admin: {t:'管理后台', s:'组织 · 人员 · 角色 · 行业库 · 授权 · 模型 · 审计'},
    settings: {t:'系统设置', s:'模型与供应商配置'},
  };

  if (authState === 'checking') return <div style={{padding:40,textAlign:"center",color:"#999"}}>正在验证登录状态…</div>;
  if (authState === 'loggedOut') return <LoginScreen onSubmit={handleLogin} error={loginError} loading={loginLoading}/>;
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  if (dbData.error) return <div style={{padding:40,textAlign:"center",color:"#999"}}>企业数据底座暂不可用，请检查 API、数据库和登录状态后重试。</div>;
  const canAdmin = CAPABILITIES.includes('*') || ['org.read','org.user.read','role.read','kb.industry.read','kb.industry.create','kb.industry.grant','audit.read'].some(permission => CAPABILITIES.includes(permission));
  const canSettings = CAPABILITIES.includes('*') || CAPABILITIES.includes('system.settings.read') || CAPABILITIES.includes('system.settings.manage');
  const visibleScreen = (screen === 'admin' && !canAdmin) || (screen === 'settings' && !canSettings) ? 'chat' : screen;
  return (
    <div className="app">
      <SideNav active={visibleScreen} setActive={setScreen} user={currentUser} onLogout={handleLogout} kbCount={KNOWLEDGE_BASES.length} capabilities={CAPABILITIES}/>
      <div className="main">
        <TopBar title={titles[visibleScreen].t} sub={titles[visibleScreen].s}/>
        <div className="content">
          {/* 四屏常驻挂载：跨屏切换不丢会话/表单状态（UX 评审修复） */}
          <div style={{display: visibleScreen==='chat'?'flex':'none', flex:1, minWidth:0}}>
          <ChatScreen/>
          </div>
          <div style={{display: visibleScreen==='libs'?'flex':'none', flex:1, minWidth:0}}>
            <LibrariesScreen initialKbId={libraryKbId} capabilities={CAPABILITIES} onManageGrant={(kb)=>{setAdminTab('grant'); setScreen('admin');}}/>
          </div>
          <div style={{display: visibleScreen==='graph'?'flex':'none', flex:1, minWidth:0}}>
            <KnowledgeGraphScreen/>
          </div>
          <div style={{display: visibleScreen==='admin' || visibleScreen==='settings'?'flex':'none', flex:1, minWidth:0}}>
            <AdminScreen initialTab={visibleScreen==='settings' ? 'model' : visibleScreen==='admin' ? adminTab : undefined} capabilities={CAPABILITIES} onOpenGrant={(k)=>{setAdminTab('grant'); setScreen('admin');}} onManageKb={(kbId)=>{setLibraryKbId(kbId); setScreen('libs');}}/>
          </div>
        </div>
      </div>
      {toast && <div className="toast"><span className="tdot"/>{toast}</div>}
    </div>
  );
}


export default App;
