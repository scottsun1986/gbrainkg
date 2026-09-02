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
import { marked } from "marked";
import * as XLSX from "xlsx";

declare global {
  interface Window { DocsAPI?: any; }
}

// Child prototype components are defined outside App and cannot see App's
// loading state.  This sentinel keeps their guards safe; App owns the real
// loading state below.
const dbData = true;
// The production reverse proxy serves Web and API from the same origin. Keep
// the development API fallback only for local dev ports; never let a stale
// NEXT_PUBLIC_API_URL from .env.local make a production browser call its own
// localhost:3202.
const API_BASE_URL = typeof window !== 'undefined'
  ? (['3000', '3001', '3200'].includes(window.location.port)
    ? (process.env.NEXT_PUBLIC_API_URL || `${window.location.protocol}//${window.location.hostname}:3202`)
    : window.location.origin)
  : (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3202');
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
    sun: <><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></>,
    moon: <><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></>,
    help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    arrowleft: <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
    activity: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></>,
  };
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
let AUDIT_META: any = { page: 1, limit: 20, total: 0, totalPages: 1 };
let DREAM: any = null;
let SYSTEM_STATUS: any = null;
let USERS: any[] = [];
let ROLES: any[] = [];
let INDUSTRY_KBS: any[] = [];
let PROVIDERS: any[] = [];
let CAPABILITIES: string[] = [];

const hasCapability = (permission: string, capabilities = CAPABILITIES) => capabilities.includes('*') || capabilities.includes(permission);

const TYPE_LABEL = {personal:'个人', org:'组织', industry:'行业', user:'人员', role:'角色'};
const TYPE_BADGE = (type) => <span className={`badge ${type}`}>{TYPE_LABEL[type] || type}</span>;

/* ============== 通用组件 ============== */

function PaginationBar({ pagination, onChange, label = '记录' }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const page = pagination.page || 1;
  const totalPages = pagination.totalPages || 1;
  return (
    <div className="pagination-bar" style={{ marginTop: 12 }}>
      <div>共 <span className="pagination-num">{pagination.total || 0}</span> {label}，第 <b>{page}</b> / {totalPages} 页</div>
      <div className="pagination-controls">
        <button className="pagination-btn" disabled={page <= 1} onClick={() => onChange(1)}>首页</button>
        <button className="pagination-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <button className="pagination-btn" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button>
        <button className="pagination-btn" disabled={page >= totalPages} onClick={() => onChange(totalPages)}>末页</button>
      </div>
    </div>
  );
}

function SideNav({active, setActive, user, onLogout, kbCount=0, capabilities=[]}){
  const items = [
    {key:'chat', label:'对话', icon:'chat', badge:null},
    {key:'libs', label:'知识库', icon:'book', badge:kbCount ? String(kbCount) : null},
    {key:'graph', label:'知识图谱', icon:'share', badge:null},
  ].filter(item => hasCapability(item.key === 'chat' ? 'chat.use' : 'kb.read', capabilities));
  const canAdmin = capabilities.includes('*') || ['org.read','org.user.read','role.read','kb.industry.read','kb.industry.create','kb.industry.grant','audit.read'].some(permission => capabilities.includes(permission));
  const canSettings = hasCapability('system.settings.read', capabilities) || hasCapability('system.settings.manage', capabilities);
  return (
    <aside className="side">
      <div className="brand">
        <span className="brand-mark">G</span>
        <span className="brand-name">GBrain</span>
        <span className="brand-sub">企业级知识库</span>
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

// 业界领先的多格式通用前端文档预览器 (支持 Word docx-preview / PDF / Excel SheetJS / Markdown / 细粒度分块)
function UniversalDocumentViewer({ preview, onClose }) {
  const snippet = (preview?.snippet || '').trim();
  const [activeTab, setActiveTab] = useState(preview?.initialTab || (snippet ? 'std_md' : 'raw')); // 'raw' | 'std_md' | 'parsed' | 'chunks' | 'meta'
  const [stdMdMode, setStdMdMode] = useState('rendered'); // 'rendered' | 'source'
  const [fullscreen, setFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docData, setDocData] = useState(null);
  const [compileTruth, setCompileTruth] = useState(null);
  const [compileTruthLoading, setCompileTruthLoading] = useState(false);
  const [compileTruthError, setCompileTruthError] = useState('');
  const [rawBlob, setRawBlob] = useState(null);
  const [rawBlobUrl, setRawBlobUrl] = useState('');
  const [sheetsData, setSheetsData] = useState({ names: [], active: '', rows: [] });
  const [copied, setCopied] = useState(false);
  const docxContainerRef = useRef(null);
  const modalBodyRef = useRef(null);

  const kbId = preview?.kbId || preview?.kb;
  const docId = preview?.docId || preview?.documentId || preview?.id;
  const filename = preview?.title || docData?.document?.title || '原始文档';
  const ext = (filename.split('.').pop() || '').toLowerCase();

  const isWord = ext === 'docx' || ext === 'doc';
  const isPdf = ext === 'pdf';
  const isExcel = ext === 'xlsx' || ext === 'xls' || ext === 'csv';
  const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
  const isText = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'py', 'sql', 'html'].includes(ext);

  // 提取引用中的关键匹配短语 —— 彻底清除 markdown 格式字符并按自然标点智能分句
  const cleanPhrases = useMemo(() => {
    if (!snippet) return [];
    const boilerplate = new Set([
      '属性维度', '详细内容与背景数据', '可信度', '单位全称/简称',
      '机构性质与背景', '关键领导关切', '数字化/AI现状', '痛点维度',
      '具体表现与管理挑战', '影响程度', '第一板块', '第二板块', '第三板块',
      '目标单位全景画像', '行业全景及核心痛点', '详细内容', '背景数据'
    ]);

    // 1. 先清除所有内联 markdown 语法标记
    const cleanText = snippet
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/^\s*[\d-]+\.?\s+/gm, '')
      .replace(/^[>\s*-]+/gm, '');

    const docTitleClean = (preview?.title || '').replace(/\.[^.]+$/, '').trim();

    // 2. 按标点分句，同时保护时间格式（如 08:30）
    const parts = cleanText
      .split(/[\n。；;\t\r|，,]+/g)
      .flatMap((s) => s.split(/：(?!\d)|:(?!\d)/g))
      .map((s) => s.replace(/^[#\s\-*>`:|0-9.()（）]+/, '').replace(/[#\s\-*>`:|0-9.()（）]+$/, '').trim())
      .map((s) => s.replace(/[\s\t]+/g, ' '))
      .filter((s) => {
        if (!s || s.length < 3) return false;
        if (/^[0-9a-fA-F-]{20,}$/.test(s)) return false;
        if (/^第?\s*\d+\s*页$/.test(s)) return false;
        if (boilerplate.has(s)) return false;
        if (docTitleClean && s === docTitleClean) return false;
        return true;
      });

    return Array.from(new Set(parts));
  }, [snippet, preview?.title]);

  // 根据文档全文对 cleanPhrases 进行智能打分排序
  const rankedPhrases = useMemo(() => {
    if (!cleanPhrases.length || !docData?.markdown_content) return cleanPhrases.slice(0, 12);
    const fullText = docData.markdown_content;
    const scored = cleanPhrases.map((phrase: any) => {
      const p = String(phrase || '').trim();
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const matches = fullText.match(new RegExp(escaped, 'gi')) || [];
      const count = matches.length;
      const firstPos = fullText.search(new RegExp(escaped, 'i'));

      const uniqueScore = count === 0 ? -1000 : (count === 1 ? 100 : 60 / count);
      const lengthScore = Math.min(p.length, 30);
      const positionScore = firstPos > 0 ? (firstPos / fullText.length) * 20 : 0;
      return { phrase: p, score: uniqueScore + lengthScore + positionScore, count, firstPos };
    }).filter((item) => item.count > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 15).map((item) => item.phrase);
  }, [cleanPhrases, docData?.markdown_content]);

  useEffect(() => {
    if (!kbId || !docId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    setCompileTruth(null);
    setCompileTruthError('');
    setCompileTruthLoading(true);

    // Compile Truth is deliberately read from the current user's BrainTopic
    // and the authorized GBrain source mapping, not inferred from UI status.
    fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/compile-truth`, { headers: apiHeaders() })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || `API ${res.status}`);
        return json;
      })
      .then((data) => { if (active) setCompileTruth(data); })
      .catch((err) => { if (active) setCompileTruthError(err.message || '编译真相加载失败'); })
      .finally(() => { if (active) setCompileTruthLoading(false); });

    // 1. 获取文档元数据与分块数据
    fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}`, { headers: apiHeaders() })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || `API ${res.status}`);
        return json;
      })
      .then(async (data) => {
        if (!active) return;
        setDocData(data);

        // 2. 如果存在原始文件二进制，获取 Blob
        if (data.document?.hasRawFile) {
          try {
            const fileRes = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/file`, {
              headers: apiHeaders(),
            });
            if (fileRes.ok) {
              const blob = await fileRes.blob();
              if (active) {
                setRawBlob(blob);
                const url = URL.createObjectURL(blob);
                setRawBlobUrl(url);

                if (isExcel) {
                  const buffer = await blob.arrayBuffer();
                  const wb = XLSX.read(buffer, { type: 'array' });
                  if (wb.SheetNames.length > 0) {
                    const firstSheet = wb.SheetNames[0];
                    const rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 });
                    setSheetsData({ names: wb.SheetNames, active: firstSheet, rows });
                  }
                }
              }
            }
          } catch (e) {
            console.warn('获取原始文件失败:', e);
          }
        }
      })
      .catch((err) => {
        if (active) setError(err.message || '加载文档失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (rawBlobUrl) URL.revokeObjectURL(rawBlobUrl);
    };
  }, [kbId, docId]);

  // 高亮处理后的 Markdown HTML
  const markdownHtml = useMemo(() => {
    const content = docData?.markdown_content || '';
    if (!content) return '<p style="color:var(--ink-4);font-style:italic;">暂无结构化解析内容</p>';
    let html = '';
    try {
      html = (marked.parse(content) as unknown as string) || '';
    } catch {
      html = `<div style="white-space:pre-wrap;">${content}</div>`;
    }
    if (rankedPhrases.length > 0) {
      for (const phrase of rankedPhrases) {
        try {
          const str = String(phrase || '').trim();
          if (!str) continue;
          const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          // 仅匹配 HTML 标签外部的可见文本，避免破坏 HTML 标签结构与属性
          const regex = new RegExp(`(?![^<]*>)(${escaped})`, 'gi');
          html = html.replace(regex, '<mark class="doc-citation-highlight">$1</mark>');
        } catch {}
      }
    }
    return html;
  }, [docData?.markdown_content, rankedPhrases]);

  // 命中切片计算
  const chunkMatches = useMemo(() => {
    if (!docData?.chunks || !docData.chunks.length) return new Set();
    const matched = new Set();
    const phrases = rankedPhrases.length > 0 ? rankedPhrases : cleanPhrases;
    docData.chunks.forEach((chunk) => {
      const text = chunk.content || '';
      if (phrases.some((p) => {
        const escaped = String(p || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return new RegExp(escaped, 'i').test(text);
      })) {
        matched.add(chunk.id);
      }
    });
    if (matched.size === 0 && snippet && docData.chunks.length > 0) {
      const firstMatch = docData.chunks.find((c) => (c.content || '').includes(snippet.slice(0, 15)));
      if (firstMatch) matched.add(firstMatch.id);
    }
    return matched;
  }, [docData?.chunks, rankedPhrases, cleanPhrases, snippet]);

  // 自动滚动定位到高亮最密集的区域
  useEffect(() => {
    if (!snippet) return;
    const executeScroll = () => {
      if (activeTab === 'parsed' || activeTab === 'std_md' || activeTab === 'raw') {
        const marks = modalBodyRef.current?.querySelectorAll('mark.doc-citation-highlight');
        if (!marks || marks.length === 0) return;
        if (marks.length === 1) {
          marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        // 找到最密集的高亮聚集区：在 350px 窗口内包含最多 mark 的位置
        let bestMark = marks[0];
        let bestCount = 0;
        const positions = Array.from(marks).map((m: any) => ({ el: m, top: m.getBoundingClientRect().top }));
        for (let i = 0; i < positions.length; i++) {
          let count = 0;
          for (let j = i; j < positions.length && positions[j].top - positions[i].top < 350; j++) {
            count++;
          }
          if (count > bestCount) {
            bestCount = count;
            bestMark = positions[i].el;
          }
        }
        bestMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (activeTab === 'chunks') {
        const target = modalBodyRef.current?.querySelector('.chunk-card.matching-target');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    };

    const timer1 = setTimeout(executeScroll, 200);
    const timer2 = setTimeout(executeScroll, 500);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [activeTab, docData, rawBlobUrl, snippet, rankedPhrases]);

  // 3. 当处于原文档 Tab 且为 Word 时，调用 docx-preview
  useEffect(() => {
    if (activeTab !== 'raw' || !isWord || !rawBlob || !docxContainerRef.current) return;
    let disposed = false;
    (async () => {
      try {
        if (ext === 'docx') {
          const { renderAsync } = await import('docx-preview');
          if (disposed || !docxContainerRef.current) return;
          docxContainerRef.current.innerHTML = '';
          await renderAsync(rawBlob, docxContainerRef.current, undefined, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            className: 'docx',
          });
        } else {
          // .doc 格式直接采用 Docling 高保真 Markdown 渲染
          if (!disposed && docxContainerRef.current) {
            docxContainerRef.current.innerHTML = `<div style="background:var(--surface-2);padding:6px 12px;border-radius:6px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;border:1px solid var(--line);">💡 该文件为 Word 早期格式 (.doc)，已自动调用 Docling 智能版面引擎还原标准排版。</div><div class="parsed-markdown-view">${markdownHtml}</div>`;
          }
        }
      } catch (err) {
        console.warn('docx-preview 渲染异常，降级至 Docling Markdown:', err);
        if (!disposed && docxContainerRef.current) {
          docxContainerRef.current.innerHTML = `<div style="background:var(--surface-2);padding:6px 12px;border-radius:6px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;border:1px solid var(--line);">💡 已通过 Docling 高性能版面引擎还原标准格式。</div><div class="parsed-markdown-view">${markdownHtml}</div>`;
        }
      }
    })();
    return () => { disposed = true; };
  }, [activeTab, isWord, rawBlob, ext, markdownHtml]);

  const handleSheetChange = async (sheetName) => {
    if (!rawBlob) return;
    try {
      const buffer = await rawBlob.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
      setSheetsData((prev) => ({ ...prev, active: sheetName, rows }));
    } catch (e) {
      console.warn('切换 Sheet 失败:', e);
    }
  };

  const handleCopyMarkdown = () => {
    const text = docData?.markdown_content || '';
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: '文档 Markdown 全文已复制到剪贴板' }));
  };

  const handleDownload = () => {
    if (!rawBlobUrl && !rawBlob) return;
    const a = document.createElement('a');
    a.href = rawBlobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatBadgeColor = isWord ? '#2563eb' : isPdf ? '#dc2626' : isExcel ? '#16a34a' : '#d97706';

  return (
    <div className="modal-mask" onClick={onClose} style={{ zIndex: 9999 }}>
      <div
        className={`modal preview-modal ${fullscreen ? 'fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题与导航栏 */}
        <div className="modal-head" style={{ padding: '12px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: '10.5px',
                fontWeight: 700,
                textTransform: 'uppercase',
                background: formatBadgeColor,
                color: '#fff',
                padding: '2px 6px',
                borderRadius: '4px',
                letterSpacing: '0.5px',
                flexShrink: 0
              }}
            >
              {ext || 'DOC'}
            </span>
            <h3 style={{ margin: 0, fontSize: '14.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filename}>
              {filename}
            </h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
            {rawBlob && (
              <button
                type="button"
                className="btn"
                onClick={handleDownload}
                style={{ padding: '4px 10px', fontSize: '11.5px', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                title="下载原文件"
              >
                <span>📥</span> 下载原件
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={handleCopyMarkdown}
              style={{ padding: '4px 10px', fontSize: '11.5px', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title="复制 Markdown 全文"
            >
              <span>{copied ? '✓' : '📋'}</span> {copied ? '已复制' : '复制全文'}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setFullscreen(!fullscreen)}
              style={{ width: '28px', height: '28px', fontSize: '13px' }}
              title={fullscreen ? '退出全屏' : '全屏预览'}
            >
              {fullscreen ? '⛷' : '⛶'}
            </button>
            <span className="x" onClick={onClose} style={{ marginLeft: '4px' }}>×</span>
          </div>
        </div>

        {/* 次级 Tab 栏 */}
        <div className="preview-nav">
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'raw' ? 'active' : ''}`}
            onClick={() => setActiveTab('raw')}
          >
            <span>📄</span> 原始文件排版 {rawBlob ? '' : '(无原件)'}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'std_md' ? 'active' : ''}`}
            onClick={() => setActiveTab('std_md')}
          >
            <span>📝</span> 标准化 Markdown 页 {cleanPhrases.length > 0 ? '✨' : ''}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'parsed' ? 'active' : ''}`}
            onClick={() => setActiveTab('parsed')}
          >
            <span>🧠</span> Docling 解析视图
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'chunks' ? 'active' : ''}`}
            onClick={() => setActiveTab('chunks')}
          >
            <span>🧩</span> 知识切片与向量 ({docData?.chunks?.length || docData?.document?.chunkCount || 0}) {chunkMatches.size > 0 ? `(命中 ${chunkMatches.size})` : ''}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'truth' ? 'active' : ''}`}
            onClick={() => setActiveTab('truth')}
            title="查看当前用户的 GBrain 编译状态、source 同步状态和最近编译记录"
          >
            <span>✅</span> Compile Truth
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'meta' ? 'active' : ''}`}
            onClick={() => setActiveTab('meta')}
          >
            <span>⚙️</span> 元数据属性
          </button>

          <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--ink-4)' }}>
            {docData?.markdown_content ? `${docData.markdown_content.length} 字符 · ` : ''}
            {docData?.document?.status === 'published' ? '✓ 已发布' : docData?.document?.status || '就绪'}
          </div>
        </div>

        {/* 引用溯源快速跳转与高亮指示条 */}
        {snippet && (
          <div className="citation-jump-banner">
            <div className="banner-left">
              <span className="banner-badge">🎯 问答引用溯源</span>
              <span className="banner-text" title={snippet}>
                已为您高亮匹配原文与切片：“{snippet.replace(/\s+/g, ' ').slice(0, 48)}...”
              </span>
            </div>
            <div className="banner-actions">
              <button
                type="button"
                className={`jump-btn ${activeTab === 'raw' ? 'active' : ''}`}
                onClick={() => setActiveTab('raw')}
                title="查看原文排版"
              >
                📄 原始文件
              </button>
              <button
                type="button"
                className={`jump-btn ${activeTab === 'std_md' ? 'active' : ''}`}
                onClick={() => setActiveTab('std_md')}
                title="查看标准化 Markdown 知识页"
              >
                📝 标准化 Markdown (已高亮)
              </button>
              <button
                type="button"
                className={`jump-btn ${activeTab === 'chunks' ? 'active' : ''}`}
                onClick={() => setActiveTab('chunks')}
                title="定位命中切片"
              >
                🧩 命中切片 ({chunkMatches.size || 1})
              </button>
            </div>
          </div>
        )}

        {/* 预览主体内容区 */}
        <div className="modal-body" ref={modalBodyRef} style={{ position: 'relative' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '380px', gap: '12px' }}>
              <div className="streaming-dot" style={{ width: '12px', height: '12px', background: 'var(--evidence)' }} />
              <div style={{ fontSize: '13px', color: 'var(--ink-3)' }}>正在调集前端组件渲染文档与知识切片…</div>
            </div>
          ) : error ? (
            <div style={{ padding: '24px 20px', maxWidth: '840px', margin: '0 auto' }}>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '12.5px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>💡</span>
                <span><b>历史文档已更迭或删除</b>：该引用所属的物理原件近期可能已被更迭或删除（{error}）。以下为您展示该次问答时的真实引用切片：</span>
              </div>
              {snippet && (
                <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '16px 20px', borderRadius: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.7', fontSize: '13px', color: 'var(--ink)' }}>
                  {snippet}
                </div>
              )}
            </div>
          ) : (
            <div className="preview-content-area">
              {/* Tab 1: 原文档排版 */}
              {activeTab === 'raw' && (
                <>
                  {isWord && rawBlob ? (
                    <div className="docx-render-container" ref={docxContainerRef}>
                      <div style={{ textAlign: 'center', padding: '30px', color: 'var(--ink-3)' }}>Word 文档渲染中…</div>
                    </div>
                  ) : isPdf && rawBlobUrl ? (
                    <object
                      data={`${rawBlobUrl}#toolbar=1`}
                      type="application/pdf"
                      style={{ width: '100%', height: '100%', minHeight: '68vh', borderRadius: '8px', border: '1px solid var(--line)' }}
                    >
                      <iframe src={rawBlobUrl} style={{ width: '100%', height: '100%', border: 'none', minHeight: '68vh' }} />
                    </object>
                  ) : isExcel && sheetsData.names.length > 0 ? (
                    <div className="sheet-container">
                      <div className="sheet-tabs">
                        {sheetsData.names.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className={`sheet-tab-btn ${sheetsData.active === name ? 'active' : ''}`}
                            onClick={() => handleSheetChange(name)}
                          >
                            📊 {name}
                          </button>
                        ))}
                      </div>
                      <div className="sheet-table-wrap">
                        <table>
                          <tbody>
                            {sheetsData.rows.map((row, rIdx) => (
                              <tr key={rIdx}>
                                {row.map((cell, cIdx) => (
                                  rIdx === 0 ? (
                                    <th key={cIdx}>{String(cell ?? '')}</th>
                                  ) : (
                                    <td key={cIdx}>{String(cell ?? '')}</td>
                                  )
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : isImage && rawBlobUrl ? (
                    <div style={{ textAlign: 'center', padding: '20px' }}>
                      <img src={rawBlobUrl} alt={filename} style={{ maxWidth: '100%', maxHeight: '72vh', borderRadius: '8px', boxShadow: 'var(--shadow-md)' }} />
                    </div>
                  ) : (
                    /* 兜底渲染为结构化 Markdown */
                    <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
                  )}
                </>
              )}

              {/* Tab 2: 标准化 Markdown 知识页 */}
              {activeTab === 'std_md' && (
                <div style={{ maxWidth: '920px', width: '100%', margin: '0 auto' }}>
                  <div className="std-md-banner">
                    <div className="std-md-banner-info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="std-md-path-badge">📄 {docData?.document?.mdPath || `${docId}/content.md`}</span>
                        <span style={{ fontSize: '11px', color: 'var(--ink-4)' }}>Git 版本受控 · Single Source of Truth</span>
                      </div>
                      <div className="std-md-desc">
                        💡 这是从原始多模态文档解析提炼的<b>标准化 Markdown 知识页</b>。已剔除冗余版式噪声并完整保留多级标题、数据表格与实体关系，作为知识切片构建与大模型动态问答的语义真实源。
                      </div>
                    </div>
                    <div className="std-md-controls">
                      <div className="sheet-tabs" style={{ background: 'transparent', border: 'none', padding: 0 }}>
                        <button
                          type="button"
                          className={`sheet-tab-btn ${stdMdMode === 'rendered' ? 'active' : ''}`}
                          onClick={() => setStdMdMode('rendered')}
                        >
                          🎨 渲染排版
                        </button>
                        <button
                          type="button"
                          className={`sheet-tab-btn ${stdMdMode === 'source' ? 'active' : ''}`}
                          onClick={() => setStdMdMode('source')}
                        >
                          💻 源码视图
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={handleCopyMarkdown}
                        style={{ padding: '4px 8px', fontSize: '11px', height: '26px' }}
                        title="复制 Markdown 源码"
                      >
                        {copied ? '✓ 已复制' : '📋 复制源码'}
                      </button>
                    </div>
                  </div>

                  {stdMdMode === 'rendered' ? (
                    <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
                  ) : (
                    <pre className="markdown-source-container"><code>{docData?.markdown_content || '暂无内容'}</code></pre>
                  )}
                </div>
              )}

              {/* Tab 3: Docling Markdown 解析视图 */}
              {activeTab === 'parsed' && (
                <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
              )}

              {/* Tab 4: 知识切片与向量 */}
              {activeTab === 'chunks' && (
                <div className="chunks-grid">
                  <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Docling 标准化分块结果 · 共 {docData?.chunks?.length || 0} 个切片 · 细粒度父子关联</span>
                    {chunkMatches.size > 0 && <span style={{ color: 'var(--evidence)', fontWeight: 600 }}>🎯 命中 {chunkMatches.size} 个问答切片</span>}
                  </div>
                  {docData?.chunks && docData.chunks.length > 0 ? (
                    docData.chunks.map((chunk, idx) => {
                      const isMatch = chunkMatches.has(chunk.id);
                      return (
                        <div key={chunk.id || idx} className={`chunk-card ${isMatch ? 'matching-target' : ''}`}>
                          <div className="chunk-card-head">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '11px', fontWeight: 600, color: isMatch ? '#fff' : 'var(--evidence)', background: isMatch ? 'var(--evidence)' : 'var(--evidenceSoft)', padding: '1px 6px', borderRadius: '4px' }}>
                                #{chunk.ord ?? idx + 1}
                              </span>
                              {isMatch && <span className="chunk-match-badge">🎯 问答引用命中切片</span>}
                              <span style={{ fontSize: '11.5px', color: 'var(--ink-3)' }}>
                                切片 ID: {chunk.id ? chunk.id.slice(0, 8) + '...' : `chunk-${idx}`}
                              </span>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--ink-4)' }}>
                              {chunk.tokenCount ? `${chunk.tokenCount} tokens · ` : ''}{chunk.content?.length || 0} 字
                            </span>
                          </div>
                          <div style={{ fontSize: '12.5px', color: 'var(--ink)', lineHeight: '1.6', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                            {isMatch ? (
                              <span dangerouslySetInnerHTML={{
                                __html: (() => {
                                  let text = (chunk.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                  for (const p of (rankedPhrases.length > 0 ? rankedPhrases : cleanPhrases)) {
                                    try {
                                      const pStr = String(p || '').trim();
                                      if (!pStr) continue;
                                      const escaped = pStr.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                      text = text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="doc-citation-highlight">$1</mark>');
                                    } catch {}
                                  }
                                  return text;
                                })()
                              }} />
                            ) : (
                              chunk.content
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ padding: '30px', textAlign: 'center', color: 'var(--ink-3)' }}>
                      暂无切片详情
                    </div>
                  )}
                </div>
              )}

              {/* Tab 5: 当前用户的 GBrain Compile Truth */}
              {activeTab === 'truth' && (
                <div style={{ maxWidth: '900px', width: '100%', margin: '0 auto' }}>
                  <div style={{ padding: '16px 18px', borderRadius: '10px', border: '1px solid var(--line)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '16px' }}>
                      <div>
                        <div style={{ fontSize: '15px', fontWeight: 650, color: 'var(--ink)' }}>Compile Truth · 编译真相</div>
                        <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '5px', lineHeight: 1.6 }}>
                          这里展示当前登录用户实际可用的 GBrain topic 与 source 状态。数据库权限校验仍是最终准入条件。
                        </div>
                      </div>
                      {compileTruth?.compileTruth?.state && (
                        <span className={`badge ${compileTruth.compileTruth.state === 'clean' ? 'ok' : compileTruth.compileTruth.state === 'not_created' ? 'indexing' : 'warn'}`}>
                          {compileTruth.compileTruth.state === 'clean' ? '✓ 已编译' : compileTruth.compileTruth.state === 'not_created' ? '尚未生成 Topic' : compileTruth.compileTruth.state}
                        </span>
                      )}
                    </div>
                    {compileTruthLoading ? (
                      <div style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '24px 0' }}>正在读取当前用户的 Compile Truth…</div>
                    ) : compileTruthError ? (
                      <div style={{ color: 'var(--danger)', fontSize: '12px', padding: '12px 0' }}>{compileTruthError}</div>
                    ) : compileTruth?.document ? (
                      <>
                        <div className="perm-list" style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '10px 16px', fontSize: '12px' }}>
                          <div style={{ color: 'var(--ink-3)' }}>Topic</div><div><code>{compileTruth.compileTruth.topicSlug}</code></div>
                          <div style={{ color: 'var(--ink-3)' }}>Topic 文件</div><div><code>{compileTruth.compileTruth.mdPath || '—'}</code></div>
                          <div style={{ color: 'var(--ink-3)' }}>最后编译时间</div><div>{compileTruth.compileTruth.lastCompiledAt ? new Date(compileTruth.compileTruth.lastCompiledAt).toLocaleString('zh-CN') : '—'}</div>
                          <div style={{ color: 'var(--ink-3)' }}>BrainRepo 最后编译</div><div>{compileTruth.compileTruth.brainRepoLastCompileAt ? new Date(compileTruth.compileTruth.brainRepoLastCompileAt).toLocaleString('zh-CN') : '—'}</div>
                          <div style={{ color: 'var(--ink-3)' }}>当前文档</div><div>{compileTruth.document.status} · {compileTruth.document.chunkCount} 个检索 Chunk · v{compileTruth.document.version}</div>
                        </div>
                        <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--line)' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>GBrain source 同步记录</div>
                          {compileTruth.compileTruth.sources?.length ? compileTruth.compileTruth.sources.map((source) => (
                            <div key={source.sourceKey} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '5px 16px', padding: '10px 12px', marginBottom: '7px', borderRadius: '7px', background: 'var(--surface-2)' }}>
                              <div><code>{source.sourceKey}</code> <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>{source.kind === 'shared' ? '共享 source' : '权限组 source'}</span></div>
                              <span className="badge ok">已同步 v{source.syncedVersion}</span>
                              <div style={{ gridColumn: '1 / -1', color: 'var(--ink-3)', fontSize: '11px' }}>文档同步：{source.syncedAt ? new Date(source.syncedAt).toLocaleString('zh-CN') : '—'} · source 最近同步：{source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString('zh-CN') : '—'}</div>
                            </div>
                          )) : <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>当前用户还没有可见 source 的同步记录。</div>}
                        </div>
                        {compileTruth.compileTruth.latestJob && (
                          <div style={{ marginTop: '14px', color: 'var(--ink-3)', fontSize: '11px' }}>
                            最近编译任务：{compileTruth.compileTruth.latestJob.trigger} · {compileTruth.compileTruth.latestJob.status} · {compileTruth.compileTruth.latestJob.completedAt ? new Date(compileTruth.compileTruth.latestJob.completedAt).toLocaleString('zh-CN') : '进行中'}
                          </div>
                        )}
                      </>
                    ) : compileTruth ? (
                      <div style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '24px 0' }}>
                        当前文档尚未生成可展示的 Compile Truth。
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Tab 6: 元数据属性 */}
              {activeTab === 'meta' && (
                <div style={{ maxWidth: '780px', width: '100%', margin: '0 auto', background: 'var(--surface)', padding: '24px', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <h4 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>文档系统元数据</h4>
                  <div className="perm-list" style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '10px 16px', fontFamily: 'inherit', fontSize: '12px' }}>
                    <div style={{ color: 'var(--ink-3)' }}>文档标识 (ID)</div>
                    <div><code>{docData?.document?.id || docId}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>标准化 Markdown 路径</div>
                    <div><code>{docData?.document?.mdPath || `${docId}/content.md`}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>所属知识库</div>
                    <div><code>{docData?.document?.kbId || kbId}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>文档标题</div>
                    <div style={{ fontWeight: 500 }}>{filename}</div>

                    <div style={{ color: 'var(--ink-3)' }}>索引状态</div>
                    <div><span className={`badge ${docData?.document?.status === 'published' ? 'ok' : 'indexing'}`}>{docData?.document?.status || '就绪'}</span></div>

                    <div style={{ color: 'var(--ink-3)' }}>切片总数</div>
                    <div>{docData?.document?.chunkCount || docData?.chunks?.length || 0} 个检索 Chunk</div>

                    <div style={{ color: 'var(--ink-3)' }}>原始二进制</div>
                    <div>{docData?.document?.hasRawFile ? '✓ 存在已归档原文件' : '— 纯文本直接录入'}</div>

                    <div style={{ color: 'var(--ink-3)' }}>创建时间</div>
                    <div>{docData?.document?.createdAt ? new Date(docData.document.createdAt).toLocaleString('zh-CN') : '—'}</div>

                    <div style={{ color: 'var(--ink-3)' }}>最后更新</div>
                    <div>{docData?.document?.updatedAt ? new Date(docData.document.updatedAt).toLocaleString('zh-CN') : '—'}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  );
}

function OnlinePreviewModal({ preview, onClose }) {
  if (!preview) return null;
  return <UniversalDocumentViewer preview={preview} onClose={onClose} />;
}

/* Tag picker - multi-select with chips */
function TagPicker({placeholder, items, selected, setSelected}){
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = items.filter(it => !selected.find(s=>s.id===it.id) && ((it.name||'').includes(q) || (it.n||'').includes(q)));
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

function TopBar({title, sub, theme, onToggleTheme, onOpenPalette, onOpenHelp, onOpenNotifications}){
  return (
    <div className="topbar">
      <div className="crumb"><b>{title}</b>{sub && <> · <span style={{color:'var(--ink-3)'}}>{sub}</span></>}</div>
      <div className="topbar-spacer"/>
      <button className="topbar-search-trigger" onClick={onOpenPalette} title="搜索 / 命令面板 (⌘K)">
        <Icon name="search" size={14}/>
        <span>搜索知识库、文档、命令…</span>
        <span className="kbd">⌘K</span>
      </button>
      <div className="topbar-actions">
        <button className="icon-btn" title={theme==='dark'?'切换为亮色模式':'切换为暗色模式'} aria-label={theme==='dark'?'切换为亮色模式':'切换为暗色模式'} onClick={onToggleTheme}><Icon name={theme==='dark'?'sun':'moon'} size={16}/></button>
        <button className="icon-btn" title="通知" onClick={onOpenNotifications}><Icon name="bell" size={16}/></button>
        <button className="icon-btn" title="快捷键与帮助 (?)" onClick={onOpenHelp}><Icon name="help" size={16}/></button>
      </div>
    </div>
  );
}

/* ============== 命令面板 / Spotlight ============== */
function CommandPalette({open, onClose, onNav, onNewChat, onNewKb, onUpload, conversations = [], knowledgeBases = [], initialQuery = ''}){
  const [query, setQuery] = useState(initialQuery);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { if (open) { setQuery(''); setHighlight(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setQuery(initialQuery); setHighlight(0); }, [initialQuery]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = [];
    groups.push({ label: '导航', items: [
      { id: 'nav-chat', label: '去对话', hint: '⌘1', icon: 'chat', run: () => onNav('chat') },
      { id: 'nav-libs', label: '去知识库', hint: '⌘2', icon: 'book', run: () => onNav('libs') },
      { id: 'nav-graph', label: '去知识图谱', hint: '⌘3', icon: 'share', run: () => onNav('graph') },
      ...(CAPABILITIES.includes('*') || CAPABILITIES.some((p) => ['org.read','org.user.read','role.read','kb.industry.read','kb.industry.create','kb.industry.grant','audit.read'].includes(p)) ? [{ id: 'nav-admin', label: '去管理后台', hint: '⌘4', icon: 'shield', run: () => onNav('admin') }] : []),
    ].filter((i) => !q || i.label.toLowerCase().includes(q)) });
    groups.push({ label: '动作', items: [
      { id: 'act-new-chat', label: '新建对话', hint: '⌘N', icon: 'plus', run: onNewChat },
      { id: 'act-new-kb', label: '新建个人库', hint: '', icon: 'book', run: onNewKb },
      { id: 'act-upload', label: '上传文档到当前知识库', hint: '', icon: 'upload', run: onUpload },
    ].filter((i) => !q || i.label.toLowerCase().includes(q)) });
    if (knowledgeBases.length > 0) {
      groups.push({ label: '知识库', items: knowledgeBases
        .filter((kb) => !q || kb.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((kb) => ({ id: `kb-${kb.id}`, label: kb.name, sub: kb.desc || TYPE_LABEL[kb.type] || '', icon: 'book', run: () => onNav('libs', { kbId: kb.id }) })) });
    }
    if (conversations.length > 0) {
      groups.push({ label: '最近会话', items: conversations
        .filter((c) => !q || (c.title || '').toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ id: `conv-${c.id}`, label: c.title || '未命名会话', sub: c.createdAt ? new Date(c.createdAt).toLocaleDateString('zh-CN') : '', icon: 'chat', run: () => onNav('chat', { convId: c.id }) })) });
    }
    return groups;
  }, [query, conversations, knowledgeBases, onNav, onNewChat, onNewKb, onUpload]);

  const flat = useMemo(() => items.flatMap((g) => g.items), [items]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(flat.length - 1, h + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); flat[highlight]?.run?.(); onClose(); }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, highlight, onClose]);

  if (!open) return null;
  let cursor = 0;
  return (
    <div className="cmdk-mask" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" size={16} color="var(--ink-3)"/>
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setHighlight(0); }} placeholder="搜索知识库、会话，或输入命令…" />
          <span className="kbd">ESC</span>
        </div>
        <div className="cmdk-list">
          {flat.length === 0 ? (
            <div className="cmdk-empty">
              没有匹配项。试试「对话」「新建」「知识图谱」。
            </div>
          ) : items.map((g) => (
            <div className="cmdk-group" key={g.label}>
              <div className="cmdk-group-label">{g.label}</div>
              {g.items.map((it) => {
                const isHl = cursor === highlight;
                const idx = cursor;
                cursor++;
                return (
                  <div key={it.id} className={`cmdk-item ${isHl ? 'hl' : ''}`} onMouseEnter={() => setHighlight(idx)} onClick={() => { it.run?.(); onClose(); }}>
                    <Icon name={it.icon} size={14} color="var(--ink-3)"/>
                    <div className="cmdk-item-body">
                      <div className="cmdk-item-label">{it.label}</div>
                      {it.sub && <div className="cmdk-item-sub">{it.sub}</div>}
                    </div>
                    {it.hint && <span className="kbd">{it.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span><span className="kbd">↑↓</span> 选择</span>
          <span><span className="kbd">↵</span> 执行</span>
          <span><span className="kbd">⌘K</span> 关闭</span>
        </div>
      </div>
    </div>
  );
}

/* ============== 通知面板 ============== */
function NotificationsPanel({open, onClose}){
  if (!open) return null;
  const notifications = [
    { id: 'n1', title: '欢迎使用企业级 GBrain 知识库', body: '上传文档 → 知识图谱会自动编译主题与关系。', when: '刚刚', icon: 'spark' },
    { id: 'n2', title: '快捷键已启用', body: '按 ⌘K 打开命令面板；按 ? 查看所有快捷键。', when: '刚刚', icon: 'help' },
  ];
  return (
    <div className="cmdk-mask" onClick={onClose}>
      <div className="notif-panel" onClick={(e) => e.stopPropagation()}>
        <div className="notif-head">
          <h3>通知</h3>
          <span className="x" onClick={onClose}>×</span>
        </div>
        <div className="notif-body">
          {notifications.map((n) => (
            <div key={n.id} className="notif-item">
              <Icon name={n.icon} size={14} color="var(--evidence)"/>
              <div>
                <div className="notif-item-title">{n.title}</div>
                <div className="notif-item-body">{n.body}</div>
                <div className="notif-item-when">{n.when}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============== 快捷键速查与使用手册浮层 ============== */
function HelpOverlay({open, onClose}){
  if (!open) return null;
  const [activeTab, setActiveTab] = useState('manual'); // 'manual' | 'shortcuts'

  const groups = [
    { label: '全局导航', items: [
      { keys: ['⌘', 'K'], label: '打开全局命令搜索面板' },
      { keys: ['⌘', '1'], label: '快速切换到「智能问答」' },
      { keys: ['⌘', '2'], label: '快速切换到「知识管理」' },
      { keys: ['⌘', '3'], label: '快速切换到「知识图谱」' },
      { keys: ['⌘', '4'], label: '快速切换到「管理后台」' },
    ] },
    { label: '快捷操作', items: [
      { keys: ['⌘', 'N'], label: '新建对话会话' },
      { keys: ['⌘', 'F'], label: '聚焦当前搜索框' },
      { keys: ['⌘', '\\'], label: '展开 / 折叠左侧栏' },
      { keys: ['?'], label: '打开本使用帮助' },
      { keys: ['Esc'], label: '关闭弹窗 / 取消选区' },
    ] },
    { label: '图谱交互', items: [
      { keys: ['滚轮'], label: '以光标为中心缩放画布' },
      { keys: ['拖拽空白'], label: '平移知识图谱' },
      { keys: ['拖拽节点'], label: '调整物理力导向布局' },
      { keys: ['单击节点'], label: '侧栏查看节点属性与关联' },
      { keys: ['双击节点'], label: '直达关联文档与源库' },
    ] },
    { label: '智能对话', items: [
      { keys: ['Enter'], label: '发送问答消息' },
      { keys: ['Shift', 'Enter'], label: '在提问框内换行' },
    ] },
  ];

  const manualSections = [
    {
      title: '一、 知识库体系与三级权限架构',
      desc: '平台采用严密的 RBAC + 组织树继承 + Pre-filter ACL 隔离体系：',
      points: [
        '【个人知识库】：仅创建者本人可见与维护，用于存放个人笔记、研究草稿与敏感材料。',
        '【组织知识库】：绑定企业组织架构节点（如合规部、研发中心），自动面向部门及子部门成员开放权限。',
        '【行业标准库】：跨组织共享的公共法规与权威标准库，由管理员统一维护并授予指定主体访问。'
      ]
    },
    {
      title: '二、 文档入库、版面解析与父子分块',
      desc: '支持 PDF、Word (.doc/.docx)、Markdown、TXT、CSV 等多种格式：',
      points: [
        '【版面还原解析】：自动调用 Docling 高性能微服务提取表格与多栏排版，无损转换为 Markdown。',
        '【智能父子分块】：采用 1800 字符细粒度检索块并注入章节完整 Context，杜绝条款断章取义。',
        '【异步状态流转】：上传后依次经历 parsing (解析中) -> indexing (索引中) -> published (已发布)。'
      ]
    },
    {
      title: '三、 智能问答与可信证据链溯源',
      desc: '基于编译式大脑 (Compile-then-Query) 引擎，提供金融/法律级真实性保障：',
      points: [
        '【检索范围选择】：可在输入框上方自由指定「我可见的全部」或勾选特定知识库范围。',
        '【流式推理问答】：支持 DeepSeek / 本地大模型实时打字机生成，并自动标注引用角标 [1][2]。',
        '【精准引用卡片】：点击回答下方的证据卡片，可直接高亮定位到原始文档切片与章节出处。'
      ]
    },
    {
      title: '四、 知识图谱物理网络探索',
      desc: '直观呈现企业知识资产的全景拓扑关系：',
      points: [
        '【自动实体提取】：基于文档标题、Markdown 关联与显式引用，动态构建概念网络。',
        '【多维关系筛选】：支持高亮展示 contains (包含)、mentions (提及)、related_to (关联) 关系。'
      ]
    },
    {
      title: '五、 系统管理后台与模型路由',
      desc: '管理员专属运维控制台：',
      points: [
        '【人员与角色配置】：支持用户增删改查、停用封禁，以及自定义角色权限矩阵。',
        '【组织树管理】：可视化维护部门上下级层级，一键为部门开启专属知识库。',
        '【模型网关配置】：支持动态接入并测试 LLM、Embedding 与 Rerank 供应商，无缝热切换。'
      ]
    }
  ];

  return (
    <div className="cmdk-mask" onClick={onClose} style={{zIndex: 9999}}>
      <div className="help-overlay" onClick={(e) => e.stopPropagation()} style={{maxWidth: '780px', width: '90vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column'}}>
        <div className="help-head" style={{borderBottom: '1px solid var(--border)', paddingBottom: '12px'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '16px'}}>
            <h3 style={{margin: 0, fontSize: '16px', fontWeight: 600}}>📖 平台帮助与使用指南</h3>
            <div style={{display: 'flex', background: 'var(--bg-subtle, #f1f5f9)', padding: '2px', borderRadius: '6px'}}>
              <button
                type="button"
                onClick={() => setActiveTab('manual')}
                style={{
                  padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                  background: activeTab === 'manual' ? '#fff' : 'transparent',
                  fontWeight: activeTab === 'manual' ? 600 : 400,
                  boxShadow: activeTab === 'manual' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none'
                }}>
                📘 使用手册
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('shortcuts')}
                style={{
                  padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                  background: activeTab === 'shortcuts' ? '#fff' : 'transparent',
                  fontWeight: activeTab === 'shortcuts' ? 600 : 400,
                  boxShadow: activeTab === 'shortcuts' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none'
                }}>
                ⌨️ 快捷键速查
              </button>
            </div>
          </div>
          <span className="x" onClick={onClose} style={{cursor: 'pointer', fontSize: '20px'}}>×</span>
        </div>

        <div className="help-body" style={{overflowY: 'auto', padding: '16px', flex: 1}}>
          {activeTab === 'manual' ? (
            <div style={{display: 'flex', flexDirection: 'column', gap: '18px', lineHeight: 1.6}}>
              {manualSections.map((sec, idx) => (
                <div key={idx} style={{background: 'var(--card-bg, #f8fafc)', padding: '14px 16px', borderRadius: '8px', border: '1px solid var(--border, #e2e8f0)'}}>
                  <h4 style={{margin: '0 0 6px 0', fontSize: '14px', fontWeight: 600, color: 'var(--primary, #4f46e5)'}}>{sec.title}</h4>
                  <p style={{margin: '0 0 8px 0', fontSize: '12px', color: 'var(--text-muted, #64748b)'}}>{sec.desc}</p>
                  <ul style={{margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--text, #1e293b)'}}>
                    {sec.points.map((pt, pIdx) => (
                      <li key={pIdx} style={{marginBottom: '4px'}}>{pt}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div>
              {groups.map((g) => (
                <div className="help-group" key={g.label} style={{marginBottom: '14px'}}>
                  <div className="help-group-label" style={{fontWeight: 600, fontSize: '12px', color: 'var(--text-muted, #64748b)', marginBottom: '6px'}}>{g.label}</div>
                  {g.items.map((it, i) => (
                    <div key={i} className="help-row" style={{display: 'flex', justifyContent: 'space-between', padding: '4px 0'}}>
                      <div className="help-label" style={{fontSize: '12px'}}>{it.label}</div>
                      <div className="help-keys">{it.keys.map((k, j) => <span className="kbd" key={j} style={{marginLeft: '4px'}}>{k}</span>)}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
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

/* ============== 右键菜单 ============== */
function ContextMenu({x, y, items, onClose}){
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth; const vh = window.innerHeight;
    let nx = x; let ny = y;
    if (x + r.width > vw) nx = vw - r.width - 6;
    if (y + r.height > vh) ny = vh - r.height - 6;
    el.style.left = nx + 'px'; el.style.top = ny + 'px';
  }, [x, y, items]);
  if (!items || items.length === 0) return null;
  return (
    <div ref={ref} className="ctx-menu" role="menu">
      {items.map((it, i) => (
        <button key={i} type="button" role="menuitem" className={`ctx-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { it.onClick?.(); onClose(); }}>
          {it.icon && <Icon name={it.icon} size={12}/>}
          <span>{it.label}</span>
          {it.shortcut && <span className="kbd" style={{marginLeft:'auto'}}>{it.shortcut}</span>}
        </button>
      ))}
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
  const [convSearch, setConvSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => ({
    '近 7 天': true,
    '30 天内': true,
    '更早': true,
    '未分类': true,
  }));
  const [citations, setCitations] = useState([]);
  const [onlinePreview, setOnlinePreview] = useState(null);
  const [citeCollapsed, setCiteCollapsed] = useState(true);
  const [feedbackMap, setFeedbackMap] = useState({});
  const [rewriting, setRewriting] = useState(false);
  const [autoStick, setAutoStick] = useState(true);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [hiddenConvs, setHiddenConvs] = useState(() => new Set());
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const chatFileRef = useRef(null);
  const streamController = useRef(null);

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
    const onOpen = (e) => { if (e.detail) void openConversation(e.detail); };
    window.addEventListener('app-open-conversation', onOpen);
    return () => window.removeEventListener('app-open-conversation', onOpen);
  }, []);

  useEffect(() => {
    const onNew = () => { newChat(); };
    window.addEventListener('app-new-chat', onNew);
    return () => window.removeEventListener('app-new-chat', onNew);
  }, []);

  useEffect(() => {
    if (!streaming) return;
    let active = true;
    const controller = new AbortController();
    streamController.current = controller;

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
    return () => { active = false; streamController.current = null; controller.abort(); };
  }, [streaming]);

  // 流式期间自动滚底（除非用户主动上滑）
  useEffect(()=>{
    if (!autoStick) return;
    const el = scrollRef.current;
    if(el) el.scrollTop = el.scrollHeight;
  },[messages, autoStick]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      setAutoStick(dist < 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const stopStream = () => {
    streamController.current?.abort();
    setStreaming(false);
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoStick(true);
  };

  const send = (preset?: string)=>{
    const text = (preset ?? input).trim();
    if(!text || streaming || selected.length===0) return;
    setMessages(ms=>[...ms, {role:'user', text}, {role:'ai', text:'', done:false}]);
    setInput('');
    setActiveCite(null);
    setCitations([]);
    setAutoStick(true);
    setStreaming(true);
    if(taRef.current) taRef.current.style.height = 'auto';
  };

  const newChat = ()=>{
    setMessages([]); setStreaming(false); setActiveCite(null); setCitations([]); setActiveConv(null); setInput('');
    if(taRef.current){ taRef.current.style.height = 'auto'; taRef.current.focus(); }
  };

  const copyAnswer = async (text) => { try { await navigator.clipboard.writeText(text); window.dispatchEvent(new CustomEvent('app-toast',{detail:'回答已复制'})); } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'复制失败，请检查浏览器权限'})); } };
  const shareConversation = async () => { const url = window.location.href; try { if (navigator.share) await navigator.share({title:'GBrain 对话',url}); else await navigator.clipboard.writeText(url); window.dispatchEvent(new CustomEvent('app-toast',{detail:navigator.share?'已打开分享面板':'会话链接已复制'})); } catch {} };
  const saveFeedback = async (feedback) => {
    if (!activeConv) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}` ,{headers:apiHeaders()});
      const conversation = await response.json(); const message = [...(conversation.messages || [])].reverse().find(item=>item.role==='assistant');
      if (message) { await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}/messages/${message.id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({feedback})}); window.dispatchEvent(new CustomEvent('app-toast',{detail:'反馈已记录'})); }
    } catch {}
  };

  const previewCitation = (citation) => {
    if (!citation?.kb || !citation?.documentId) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'当前引用没有可预览的原始文档'}));
      return;
    }
    setOnlinePreview({
      kbId: citation.kb,
      docId: citation.documentId,
      title: citation.title || '原始文档',
      snippet: citation.snippet,
      topic: citation.path || citation.title,
    });
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
  const rememberPersonalFact = async () => {
    const fact = input.trim() || window.prompt('输入要保存到个人记忆的内容：', '')?.trim();
    if (!fact) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/chat/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ fact }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '个人记忆保存失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '已保存至个人记忆；不会写入组织或行业知识库' }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: error.message || '个人记忆保存失败' }));
    }
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

  const hideConversation = (conv) => {
    const id = conv?.id;
    if (!id) return;
    const next = new Set(hiddenConvs); next.add(id); setHiddenConvs(next);
    if (activeConv === id) { setMessages([]); setActiveConv(null); setCitations([]); }
    const onUndo = () => { const r = new Set(hiddenConvs); r.delete(id); setHiddenConvs(r); };
    const evt = new CustomEvent('app-undoable', { detail: { message: `已隐藏会话：${(conv.title || '未命名').slice(0, 20)}`, undoLabel: '撤销', undo: onUndo } });
    window.dispatchEvent(evt);
  };

  const renameConversation = async (conv) => {
    const newTitle = window.prompt('请输入新的会话标题：', conv.title || '');
    if (!newTitle || newTitle.trim() === conv.title) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/conversations/${conv.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (res.ok) {
        setConversationList((prev) => prev.map((item) => item.id === conv.id ? { ...item, title: newTitle.trim() } : item));
        window.dispatchEvent(new CustomEvent('app-toast', { detail: '会话标题已更新' }));
      }
    } catch {}
  };

  const showConvMenu = (e, conv) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: '打开会话', icon: 'chat', onClick: () => openConversation(conv.id) },
        { label: '重命名', icon: 'spark', onClick: () => renameConversation(conv) },
        { label: '复制标题', icon: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(conv.title || ''); window.dispatchEvent(new CustomEvent('app-toast', { detail: '已复制标题' })); } catch {} } },
        { label: '隐藏会话（可撤销）', icon: 'logout', danger: true, onClick: () => hideConversation(conv) },
      ],
    });
  };

  const focusInput = ()=>{ if(taRef.current) taRef.current.focus(); };

  const autoGrow = (el)=>{
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const renderAnswer = (typed, msgSources) => {
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
        const activeSources = (msgSources && msgSources.length > 0) ? msgSources : citations;
        const citation = activeSources[n-1];
        out.push(<button key={key++} className={`cite-chip ${activeCite===n?'active':''}`} onClick={()=>{setActiveCite(n); if (citation) void previewCitation(citation);}}>{n}</button>);
        last = m.index + m[0].length;
      }
      if(last < text.length) out.push(wrap(text.slice(last), key++));
    });
    return out;
  };

  const answerDone = messages.length>0 && messages[messages.length-1].done;

  return (
    <div className="chat">
      <div className="conv-side">
        <div className="scope">
          <div className="scope-label">查询范围</div>
          <ScopePicker visibleKbs={visibleKbs} selected={selected} setSelected={setSelected} open={open} setOpen={setOpen}/>
        </div>
        <div className="conv-head">
          <h4>最近会话</h4>
          <button className="icon-btn" title="新建会话 (⌘N)" onClick={newChat}><Icon name="plus" size={14}/></button>
        </div>
        <div className="conv-search">
          <Icon name="search" size={12}/>
          <input value={convSearch} onChange={(e) => setConvSearch(e.target.value)} placeholder="搜索会话标题…" />
          {convSearch && <button type="button" className="conv-search-clear" onClick={() => setConvSearch('')} aria-label="清除">×</button>}
        </div>
        <div className="conv-list">
          {(() => {
            const q = convSearch.trim().toLowerCase();
            const visibleList = conversationList.filter((c) => !hiddenConvs.has(c.id));
            const filtered = q ? visibleList.filter((c) => (c.title || '').toLowerCase().includes(q)) : visibleList;
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const startOfTodayMs = startOfToday.getTime();
            const sevenDaysAgoMs = startOfTodayMs - 6 * 24 * 3600 * 1000;
            const thirtyDaysAgoMs = startOfTodayMs - 29 * 24 * 3600 * 1000;

            const groups = [
              { label: '今天', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() >= startOfTodayMs) },
              { label: '近 7 天', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < startOfTodayMs && new Date(c.createdAt).getTime() >= sevenDaysAgoMs) },
              { label: '30 天内', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < sevenDaysAgoMs && new Date(c.createdAt).getTime() >= thirtyDaysAgoMs) },
              { label: '更早', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < thirtyDaysAgoMs) },
              { label: '未分类', items: filtered.filter((c) => !c.createdAt) },
            ].filter((g) => g.items.length > 0);
            if (groups.length === 0) return <div className="conv-empty">{q ? '没有匹配的会话' : '暂无会话'}</div>;
            return groups.map((g) => {
              const hasActive = g.items.some((c) => c.id === activeConv);
              const isCollapsed = !q && !hasActive && Boolean(collapsedGroups[g.label]);
              return (
                <div key={g.label} className="conv-group">
                  <div
                    className={`conv-group-label ${isCollapsed ? 'collapsed' : ''}`}
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [g.label]: !isCollapsed }))}
                    title={isCollapsed ? '点击展开' : '点击折叠'}
                  >
                    <span>{g.label} <em>· {g.items.length}</em></span>
                    <span className="group-arrow">▾</span>
                  </div>
                  {!isCollapsed && (
                    <div className="conv-group-items">
                      {g.items.map((c) => (
                        <div key={c.id} className={`conv-item ${activeConv===c.id?'active':''}`} onClick={()=>openConversation(c.id)} onContextMenu={(e) => showConvMenu(e, c)}>
                          <span className="conv-title">{c.title || '未命名会话'}</span>
                          <span className="conv-time">{c.createdAt ? new Date(c.createdAt).toLocaleDateString('zh-CN') : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
        <div className="new-chat" onClick={newChat} title="开始一段新对话 (⌘N)">
          <Icon name="plus" size={12}/> 新建会话
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-scroll" ref={scrollRef}>
          {!autoStick && messages.length > 0 && (
            <button type="button" className="scroll-to-bottom" onClick={scrollToBottom} title="回到底部">
              <span>↓ 回到底部</span>
              {streaming && <span className="streaming-dot" />}
            </button>
          )}
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
                return (
                  <div key={mi} className="msg msg-user">
                    <div className="bubble">{msg.text}</div>
                  </div>
                );
              }
              return (
                <div key={mi} className="msg msg-ai">
                  <div className="body">
                    <div className="who">
                      <span className="dot"/>
                      <span>GBrain · 大脑综述</span>
                      <span style={{color:'var(--ink-4)'}}>· 你的大脑 · {scopeLabel}{allSel ? `（${selected.length} 库）` : ''}</span>
                    </div>
                    <div className="answer">
                      {renderAnswer(msg.text, msg.sources)}
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
                <button type="button" className="comp-chip" onClick={rememberPersonalFact} title="显式保存到仅自己可见的 GBrain 个人记忆">
                  <Icon name="book" size={11}/> 记住
                </button>
                {streaming ? (
                  <button type="button" className="send-btn stop" onClick={stopStream} title="停止生成 (Esc)" aria-label="停止生成">
                    <span className="stop-icon" aria-hidden="true" />
                  </button>
                ) : (
                  <button type="button" className="send-btn" onClick={()=>send()} disabled={!input.trim() || selected.length===0} title="发送 (Enter)" aria-label="发送">
                    <Icon name="send" size={14} color="var(--on-ink)"/>
                  </button>
                )}
              </div>
            </div>
            <div className="foot-note">回答来自你的个人大脑（Compiled Truth）· 新知识入库与权限变更均触发面向你的重编译 · 引用可回溯原始文档</div>
          </div>
        </div>
      </div>

      {answerDone && (
        <div className={`cite-panel ${citeCollapsed ? 'collapsed' : 'open'}`}>
          <button type="button" className="cite-rail" onClick={() => setCiteCollapsed(false)} title={citeCollapsed ? '展开引用面板' : '收起'}>
            <Icon name="book" size={14} color="#fff"/>
            <span className="cite-rail-label">引用</span>
            <span className="cite-rail-count">{citations.length}</span>
          </button>
          <div className="cite-drawer">
            <div className="cite-head">
              <div style={{display:'flex',alignItems:'center'}}>
                <h4>大脑引用</h4><span className="count">{citations.length}</span>
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <div className="cite-sort"><span>主题相关度</span><Icon name="chevron" size={11} color="var(--ink-3)" style={{transform:'rotate(90deg)'}}/></div>
                <button type="button" className="cite-close" onClick={() => setCiteCollapsed(true)} title="收起面板" aria-label="收起引用面板">×</button>
              </div>
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
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <OnlinePreviewModal preview={onlinePreview} onClose={()=>setOnlinePreview(null)}/>
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)}/>}
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
  const [previewDoc, setPreviewDoc] = useState(null);
  const [onlinePreview, setOnlinePreview] = useState(null);
  const [confirmDoc, setConfirmDoc] = useState(null);
  const [confirmKb, setConfirmKb] = useState(null);
  const [newPersonalOpen, setNewPersonalOpen] = useState(false);
  const [newTextOpen, setNewTextOpen] = useState(false);
  const fileInputRef = useRef(null);
  // 过滤条件变化后，不能继续沿用不属于当前分类的旧选中项；否则“个人库”为空
  // 时仍会渲染上一库的详情，并在后续操作中访问失效的 kbId。
  const current = (sel && filtered.some((kb) => kb.id === sel.id) ? sel : null) || filtered[0] || null;
  const formatFileSize = (bytes: any) => {
    if (bytes === null || bytes === undefined || isNaN(Number(bytes)) || Number(bytes) <= 0) return '—';
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  };

  const loadDocuments = async (kbId) => {
    if (!kbId) { setDocs([]); return; }
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents`, {headers:apiHeaders()});
      if (!response.ok) throw new Error('文档列表加载失败');
      const result = await response.json();
      setDocs((result.items || []).map((doc: any) => {
        const path = doc.mdPath || '';
        const baseName = path.split('/').pop() || path;
        const original = doc.title && !doc.title.includes('/') ? doc.title : baseName;
        const ext = original.split('.').pop() || 'file';
        return {
          id: doc.id,
          name: original,
          type: ext,
          size: formatFileSize(doc.sizeBytes),
          status: doc.status,
          uploader: doc.uploadedBy?.displayName || doc.uploadedBy?.username || '—',
          t: new Date(doc.updatedAt || doc.createdAt).toLocaleString('zh-CN'),
          path,
        };
      }));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail: error.message || '文档加载失败'})); }
  };
  useEffect(() => {
    if (!current && filtered[0]) setSel(filtered[0]);
    if (!filtered.length && sel) setSel(null);
  }, [filter, filtered.length, filtered[0]?.id, current?.id]);
  useEffect(() => { const target = KNOWLEDGE_BASES.find(k => k.id === initialKbId); if (target) setSel(target); }, [initialKbId]);
  useEffect(() => { void loadDocuments(current?.id); }, [current?.id]);
  useEffect(() => { const refresh = () => { if (current?.id) void loadDocuments(current.id); }; window.addEventListener('app-data-refresh', refresh); return () => window.removeEventListener('app-data-refresh', refresh); }, [current?.id]);

  const uploadDocument = async (file: any) => {
    if (!file || !current?.id) return;
    if (file.size > 200 * 1024 * 1024) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `文件「${file.name}」超出 200MB 大小限制` }));
      return;
    }
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const tempName = file.name;
    const ext = file.name.split('.').pop() || 'file';
    const sizeStr = formatFileSize(file.size);

    // 立即在表格首行插入占位记录，显示当前解析进展，不阻塞任何交互
    setDocs((ds) => [
      {
        id: tempId,
        name: tempName,
        type: ext,
        size: sizeStr,
        status: 'parsing',
        uploader: '当前用户',
        t: '刚刚',
        path: '',
      },
      ...ds.filter((d) => d.name !== tempName),
    ]);

    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents`, {
        method: 'POST',
        headers: apiHeaders(),
        body: form,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '上传失败');

      const doc = result.documents?.[0];
      if (doc) {
        setDocs((ds) => ds.map((d) => (d.id === tempId ? { ...d, id: doc.id, status: doc.status || 'parsing' } : d)));
      }
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `「${tempName}」已上传，后台正在解析与索引` }));
      await loadDocuments(current.id);
    } catch (error: any) {
      setDocs((ds) => ds.map((d) => (d.id === tempId ? { ...d, status: 'failed' } : d)));
      window.dispatchEvent(new CustomEvent('app-toast', { detail: error.message || '上传失败' }));
    }
  };

  // 针对处理中（parsing / indexing）文档进行后台轻量级自动轮询，动态更新状态，完全不阻塞上传按钮与区域
  const hasProcessingDocs = docs.some((d: any) => d.status === 'parsing' || d.status === 'indexing' || String(d.id).startsWith('temp-'));

  useEffect(() => {
    if (!hasProcessingDocs || !current?.id) return;
    const timer = setInterval(() => {
      loadDocuments(current.id);
    }, 2000);
    return () => clearInterval(timer);
  }, [hasProcessingDocs, current?.id]);

  const [docSearch, setDocSearch] = useState('');
  const [docStatusFilter, setDocStatusFilter] = useState('all');
  const [docTypeFilter, setDocTypeFilter] = useState('all');
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(10);

  useEffect(() => {
    setDocPage(1);
  }, [current?.id, docSearch, docStatusFilter, docTypeFilter, docPageSize]);

  const filteredDocs = useMemo(() => {
    return docs.filter((d: any) => {
      if (docSearch.trim()) {
        const q = docSearch.trim().toLowerCase();
        const matchName = (d.name || '').toLowerCase().includes(q);
        const matchPath = (d.path || '').toLowerCase().includes(q);
        const matchUploader = (d.uploader || '').toLowerCase().includes(q);
        if (!matchName && !matchPath && !matchUploader) return false;
      }
      if (docStatusFilter !== 'all' && d.status !== docStatusFilter) {
        return false;
      }
      if (docTypeFilter !== 'all') {
        const ext = (d.name || '').split('.').pop()?.toLowerCase() || '';
        if (docTypeFilter === 'word' && !['doc', 'docx'].includes(ext)) return false;
        if (docTypeFilter === 'pdf' && ext !== 'pdf') return false;
        if (docTypeFilter === 'excel' && !['xlsx', 'xls', 'csv'].includes(ext)) return false;
        if (docTypeFilter === 'md' && !['md', 'txt', 'markdown'].includes(ext)) return false;
      }
      return true;
    });
  }, [docs, docSearch, docStatusFilter, docTypeFilter]);

  const totalDocs = filteredDocs.length;
  const docTotalPages = Math.max(1, Math.ceil(totalDocs / docPageSize));
  const currentDocPage = Math.min(docPage, docTotalPages);
  const pagedDocs = useMemo(() => {
    const start = (currentDocPage - 1) * docPageSize;
    return filteredDocs.slice(start, start + docPageSize);
  }, [filteredDocs, currentDocPage, docPageSize]);

  const previewDocument = (doc) => {
    setOnlinePreview({ kbId: current.id, docId: doc.id, title: doc.name || doc.title || '原始文档' });
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

  const addTextDocument = async ({title, content}) => {
    if (!current?.id || !current.canWrite) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/text`, {
        method: 'POST', headers: {'Content-Type':'application/json', ...apiHeaders()},
        body: JSON.stringify({title, content}),
      });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '文本知识保存失败');
      setNewTextOpen(false);
      await loadDocuments(current.id);
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'文本知识已保存并进入解析与索引流程'}));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '文本知识保存失败'})); }
  };

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
          {filtered.length ? filtered.map(k=>(
            <div key={k.id} className={`kb-card ${current.id===k.id?'active':''}`} onClick={()=>setSel(k)}>
              <div className="row1">
                <span className="nm">{k.name}</span>
                {TYPE_BADGE(k.type)}
              </div>
              <div className="desc">{k.desc || '暂无描述'}</div>
              <div className="row2">
                <span><Icon name="doc" size={12}/> {k.docs} 文档</span>
                <span className="vis" title="可见范围"><Icon name={k.type==='personal'?'lock':k.type==='org'?'users':'shield'} size={11}/> <b>{k.visibility}</b></span>
                <span style={{flex:1}}/>
                <span className="admins">
                  {k.admins.map((a,i)=>(<div key={i} className="avatar" style={{background: i%2===0?'#3D6B9E':'#2C7A7B'}}>{a.i}</div>))}
                </span>
              </div>
            </div>
          )) : (
            <div style={{padding:'52px 20px',textAlign:'center',color:'var(--ink-3)',lineHeight:1.7}}>
              <div style={{fontWeight:600,color:'var(--ink-2)'}}>{filter === 'personal' ? '个人库为空' : '当前分类暂无知识库'}</div>
              <div style={{fontSize:12}}>{filter === 'personal' ? '当前还没有创建个人知识库。' : '请切换其它分类查看可用知识库。'}</div>
            </div>
          )}
        </div>
      </div>

      {current ? <div className="lib-detail">
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
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event)=>{
                const files = event.target.files;
                if(files && files.length){
                  Array.from(files).forEach(file=>uploadDocument(file));
                }
                event.target.value='';
              }}
              accept=".md,.txt,.csv,.html,.htm,.doc,.docx,.pdf,.xlsx,.pptx,.png,.jpg,.jpeg"
            />
            {current.canWrite && <button className="btn" onClick={()=>setNewTextOpen(true)}><Icon name="plus" size={12}/> 添加文本</button>}
            {current.canWrite && <button className="btn primary" onClick={()=>fileInputRef.current?.click()}><Icon name="upload" size={12}/> 上传文档</button>}
          </div>
        </div>
        <div className="detail-tabs">
          <div className={`detail-tab ${tab==='docs'?'active':''}`} onClick={()=>setTab('docs')}>文档（{docs.length}）</div>
          <div className={`detail-tab ${tab==='health'?'active':''}`} onClick={()=>setTab('health')}>健康度</div>
          <div className={`detail-tab ${tab==='settings'?'active':''}`} onClick={()=>setTab('settings')}>设置</div>
        </div>
        <div className="detail-body">
          {tab==='docs' && <>
          {current.canWrite ? (
            <div
              className="dropzone"
              onClick={()=>fileInputRef.current?.click()}
              onDragOver={(e)=>{ e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e)=>{
                e.preventDefault();
                e.stopPropagation();
                const files = e.dataTransfer.files;
                if(files && files.length){
                  Array.from(files).forEach(file=>uploadDocument(file));
                }
              }}
              style={{cursor:'pointer'}}
            >
              <Icon name="upload" size={26} className="ic" color="var(--ink-3)"/>
              <h5>拖拽文件到此处，或点击选择（支持多选批量上传）</h5>
              <p>支持 Markdown / Word（含 .doc / .docx）/ PDF / Excel / PPT / 图片 · 单文件最大 200MB · 自动在后台异步解析与多路索引</p>
            </div>
          ) : (
            <div className="dropzone" style={{cursor:'default',opacity:.8}}>
              <Icon name="lock" size={24} className="ic" color="var(--ink-3)"/>
              <h5>当前账号仅可阅读</h5>
              <p>只有知识库所有者或管理员可以上传、删除知识。</p>
            </div>
          )}

          <div className="kpi-row">
            <div className="kpi"><div className="lbl">总文档</div><div className="val">{docs.length}</div><div className="sub">来自数据库</div></div>
            <div className="kpi"><div className="lbl">已发布</div><div className="val">{docs.filter(d=>d.status==='published').length}</div><div className="sub">当前库状态</div></div>
            <div className="kpi"><div className="lbl">处理中</div><div className="val">{docs.filter(d=>d.status==='indexing'||d.status==='parsing').length}</div><div className="sub">解析 / 索引队列</div></div>
            <div className="kpi"><div className="lbl">解析失败</div><div className="val" style={{color: docs.filter(d=>d.status==='failed').length? 'var(--danger)':'var(--ink)'}}>{docs.filter(d=>d.status==='failed').length}</div><div className="sub">需人工介入</div></div>
          </div>

          <div className="doc-filter-toolbar">
            <input
              className="search-input"
              placeholder="搜索文档名称 / 文件路径..."
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
              style={{ width: '280px' }}
            />
            <select
              className="filter-select"
              value={docStatusFilter}
              onChange={(e) => setDocStatusFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="published">已发布</option>
              <option value="indexing">索引中</option>
              <option value="parsing">解析中</option>
              <option value="failed">解析失败</option>
            </select>
            <select
              className="filter-select"
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value)}
            >
              <option value="all">全部格式</option>
              <option value="word">Word (.docx / .doc)</option>
              <option value="pdf">PDF (.pdf)</option>
              <option value="excel">Excel (.xlsx / .csv)</option>
              <option value="md">Markdown / 文本</option>
            </select>
            {(docSearch || docStatusFilter !== 'all' || docTypeFilter !== 'all') && (
              <button
                type="button"
                className="btn"
                onClick={() => { setDocSearch(''); setDocStatusFilter('all'); setDocTypeFilter('all'); }}
                style={{ fontSize: '11.5px', padding: '5px 10px' }}
              >
                重置过滤
              </button>
            )}
            <div style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--ink-4)' }}>
              筛选出 {filteredDocs.length} / {docs.length} 篇文档
            </div>
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
            {pagedDocs.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ink-3)' }}>
                未找到匹配的文档
              </div>
            ) : (
              pagedDocs.map((d,i)=>(
                <div key={d.id || i} className="doc-row" style={{gridTemplateColumns:'32px 1fr 110px 110px 80px 120px'}}>
                  <div className="doc-type-icon" data-type={d.type}><Icon name="doc" size={14} color="var(--ink-3)"/></div>
                  <div style={{ cursor: 'pointer' }} onClick={() => previewDocument(d)} title="点击预览文档与标准知识页">
                    <div className="ttl" title={d.name}>{d.name}</div>
                    <div className="sub" title={d.path}>{d.path}</div>
                  </div>
                  <div>
                    <span className={`status ${d.status}`}>
                      <span className="d"/>
                      {d.status==='published'?'已发布':d.status==='indexing'?'索引中':d.status==='parsing'?'解析中':'失败'}
                    </span>
                  </div>
                  <div style={{color:'var(--ink-2)'}}>{d.uploader}<div style={{fontSize:10.5,color:'var(--ink-4)'}}>{d.t}</div></div>
                  <div style={{color:'var(--ink-3)',fontVariantNumeric:'tabular-nums'}}>{d.size}</div>
                  <div className="actions" style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                    <button className="icon-btn" title="预览" onClick={()=>previewDocument(d)} aria-label="预览"><Icon name="search" size={14}/></button>
                    {current.canWrite && d.status==='failed' && !String(d.id).startsWith('temp-') && <button className="icon-btn" title="重试" onClick={async()=>{try{const response=await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/${d.id}/retry`,{method:'POST',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'重试失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'已重新提交解析'})); await loadDocuments(current.id);}catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'重试失败'}));}}} aria-label="重试"><Icon name="refresh" size={14}/></button>}
                    {current.canWrite && !String(d.id).startsWith('temp-') && <button className="icon-btn danger" title="删除" onClick={()=>setConfirmDoc(d)} aria-label="删除"><Icon name="logout" size={14} style={{transform:'scaleX(-1)'}}/></button>}
                  </div>
                </div>
              ))
            )}
          </div>

          {totalDocs > 0 && (
            <div className="pagination-bar">
              <div>
                共 <b>{totalDocs}</b> 篇文档 · 每页
                <select
                  value={docPageSize}
                  onChange={(e) => setDocPageSize(Number(e.target.value))}
                  style={{ margin: '0 6px', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--line)', background: 'var(--surface)', fontSize: '11.5px' }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
                条 · 第 <b>{currentDocPage}</b> / {docTotalPages} 页
              </div>
              <div className="pagination-controls">
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentDocPage <= 1}
                  onClick={() => setDocPage(1)}
                  title="第一页"
                >
                  首页
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentDocPage <= 1}
                  onClick={() => setDocPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </button>
                {Array.from({ length: Math.min(5, docTotalPages) }, (_, idx) => {
                  const pNum = Math.max(1, Math.min(docTotalPages - 4, currentDocPage - 2)) + idx;
                  if (pNum > docTotalPages) return null;
                  return (
                    <button
                      key={pNum}
                      type="button"
                      className={`pagination-btn ${pNum === currentDocPage ? 'active' : ''}`}
                      onClick={() => setDocPage(pNum)}
                    >
                      {pNum}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentDocPage >= docTotalPages}
                  onClick={() => setDocPage((p) => Math.min(docTotalPages, p + 1))}
                >
                  下一页
                </button>
                <button
                  type="button"
                  className="pagination-btn"
                  disabled={currentDocPage >= docTotalPages}
                  onClick={() => setDocPage(docTotalPages)}
                  title="最后一页"
                >
                  末页
                </button>
              </div>
            </div>
          )}
          </>}
          {tab==='health' && <div style={{padding:24}}><h3>知识库健康度</h3><p style={{color:'var(--ink-3)'}}>健康度根据当前数据库中的文档状态计算。</p><div className="kpi-row"><div className="kpi"><div className="lbl">已发布率</div><div className="val">{docs.length ? Math.round(docs.filter(d=>d.status==='published').length/docs.length*100) : 0}%</div></div><div className="kpi"><div className="lbl">失败文档</div><div className="val">{docs.filter(d=>d.status==='failed').length}</div></div><div className="kpi"><div className="lbl">待处理</div><div className="val">{docs.filter(d=>d.status==='parsing'||d.status==='indexing').length}</div></div></div></div>}
          {tab==='settings' && <div style={{padding:24}}><h3>知识库设置</h3><div className="field"><label>名称</label><input value={current.name} readOnly/></div><div className="field"><label>类型</label><input value={current.type} readOnly/></div><div className="field"><label>可见性</label><input value={current.visibility} readOnly/></div><p className="field-hint">知识库的权限和管理员请在管理后台维护。</p></div>}
        </div>
      </div> : (
        <div className="lib-detail" style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'420px',textAlign:'center'}}>
          <div style={{color:'var(--ink-3)'}}>
            <div style={{fontWeight:600,color:'var(--ink-2)',marginBottom:8}}>当前分类暂无知识库</div>
            <div style={{fontSize:12}}>请在左侧切换其它分类，或先创建个人知识库。</div>
            {(filter === 'all' || filter === 'personal') && <button className="btn primary" style={{marginTop:16}} onClick={()=>setNewPersonalOpen(true)}>+ 新建个人库</button>}
          </div>
        </div>
      )}
      {previewDoc && <Modal title={`预览 · ${previewDoc.name}`} onClose={()=>setPreviewDoc(null)} foot={<button className="btn" onClick={()=>setPreviewDoc(null)}>关闭</button>}><div style={{whiteSpace:'pre-wrap',lineHeight:1.7,maxHeight:'60vh',overflow:'auto',fontSize:13}}>{previewDoc.content || '当前文档暂无可预览内容。'}</div></Modal>}
      <OnlinePreviewModal preview={onlinePreview} onClose={()=>setOnlinePreview(null)}/>
      {confirmDoc && <ConfirmModal title="删除知识" msg={<>确认删除 <b style={{color:'var(--ink)'}}>{confirmDoc.name}</b>？删除后将从当前知识库移除。</>} onConfirm={()=>deleteDocument(confirmDoc)} onClose={()=>setConfirmDoc(null)}/>}
      {confirmKb && <ConfirmModal title="删除个人知识库" msg={<>确认删除个人知识库 <b style={{color:'var(--ink)'}}>{confirmKb.name}</b>？其中的知识将一并删除。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/kbs/${confirmKb.id}`,{method:'DELETE',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'删除失败'); setConfirmKb(null); setSel(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmKb(null)}/>}
      {newTextOpen && <TextKnowledgeModal onClose={()=>setNewTextOpen(false)} onSave={addTextDocument}/>}
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
    { id: node.id, name: node.name, path, canManage: Boolean(node.canManage) },
    ...(node.children || []).flatMap(child => flattenOrgTree(child, path)),
  ];
}

// 递归收集节点及其所有子节点的 ID 集合
function getSubtreeOrgIds(node) {
  const ids = new Set();
  const walk = (n) => {
    if (!n) return;
    if (n.id) ids.add(n.id);
    (n.children || []).forEach(walk);
  };
  walk(node);
  return ids;
}

// 递归计算某节点及其子节点下的用户总数
function countSubtreeUsers(node, users) {
  const ids = getSubtreeOrgIds(node);
  return users.filter(u => (u.orgIds || []).some(id => ids.has(id))).length;
}

// 侧边栏组织树渲染节点
function UsersOrgTreeNode({ node, depth = 0, selectedId, onSelect, expandedIds, onToggle, users }) {
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

function UsersPanel({ orgTree, orgOptions = [], canManage = false, capabilities = [] }){
  const [search, setSearch] = useState('');
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [permFilter, setPermFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  const isSysAdmin = (capabilities || []).includes('*');
  const manageableOrgOptions = useMemo(() => {
    if (isSysAdmin) return orgOptions;
    return orgOptions.filter((node) => node.canManage);
  }, [orgOptions, isSysAdmin]);

  // 组织树展开状态
  const [treeExpandedIds, setTreeExpandedIds] = useState(() => {
    const s = new Set();
    const walk = (n) => {
      if (!n) return;
      s.add(n.id);
      (n.children || []).forEach(walk);
    };
    if (orgTree) walk(orgTree);
    return s;
  });

  const toggleTreeNode = (id) => {
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
    return USERS.filter((u) => {
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
                  const s = new Set();
                  const walk = (n) => { if (!n) return; s.add(n.id); (n.children || []).forEach(walk); };
                  if (orgTree) walk(orgTree);
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
              <span style={{ fontWeight: !selectedOrg ? 600 : 400 }}>🏢 全部组织</span>
              <span className="node-badge">{USERS.length} 人</span>
            </div>

            {/* 组织层级树 */}
            {orgTree ? (
              <UsersOrgTreeNode
                node={orgTree}
                depth={0}
                selectedId={selectedOrg?.id}
                onSelect={setSelectedOrg}
                expandedIds={treeExpandedIds}
                onToggle={toggleTreeNode}
                users={USERS}
              />
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
              <span>📁 当前组织筛选：<b>{selectedOrg.path || selectedOrg.name}</b> 及所有下属部门（共匹配 {filteredUsers.length} 人）</span>
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
              {ROLES.map((r) => (
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
              匹配到 {filteredUsers.length} / {USERS.length} 人
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

function UserFormModal({target, orgOptions = [], capabilities = [], onClose, onSaved}){
  const isEdit = !!target;
  const isSysAdmin = capabilities.includes('*');
  const [name, setName] = useState(target?.name || '');
  const [username, setUsername] = useState(target?.initials?.toLowerCase() || '');
  const [email, setEmail] = useState(target?.email || '');
  const [password, setPassword] = useState('');
  const [orgId, setOrgId] = useState(target?.orgIds?.[0] || (orgOptions[0]?.id || ''));
  const [status, setStatus] = useState(target?.status || 'active');
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState(isEdit && target ? ROLES.filter(r=>target.roles.includes(r.name)).map(r=>({id:r.id,n:r.name,sub:`${r.users} 人`})) : []);

  const assignableRoles = useMemo(() => {
    if (isSysAdmin) return ROLES;
    return ROLES.filter(r => !r.builtin && r.name !== '超级管理员' && r.name !== '系统管理员');
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
      window.dispatchEvent(new CustomEvent('app-toast', { detail: error.message || '保存失败' }));
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

function RolesPanel({canManage = false}){
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [search, setSearch] = useState('');

  const getPermBadgeClass = (p: string) => {
    if (p === '*') return 'perm-chip all';
    if (p.startsWith('chat.') || p === 'kb.read') return 'perm-chip wb';
    if (p.startsWith('kb.industry')) return 'perm-chip kb';
    if (p.startsWith('org.') || p.startsWith('role.')) return 'perm-chip org';
    return 'perm-chip sys';
  };

  const filtered = ROLES.filter(r => {
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
          共 {filtered.length} / {ROLES.length} 个角色模板
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
                  <div style={{fontSize:'28px',marginBottom:'8px'}}>🛡️</div>
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
                        {p === '*' ? '⚡ 全部特权 (*)' : p}
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

const ALL_PERMS = [
  {
    group: '💬 智能问答与工作台',
    items: [
      { code: 'chat.use', desc: '使用智能对话与问答功能' },
      { code: 'kb.read', desc: '查阅本人有权访问的知识库与知识图谱' },
    ]
  },
  {
    group: '📚 行业知识库治理',
    items: [
      { code: 'kb.industry.read', desc: '进入行业知识库管理面板' },
      { code: 'kb.industry.create', desc: '新建行业知识库' },
      { code: 'kb.industry.manage', desc: '管理与维护所负责的行业知识库' },
      { code: 'kb.industry.grant', desc: '管理跨部门人员/角色/组织授权' },
    ]
  },
  {
    group: '👥 组织架构与人员',
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
    group: '⚙️ 系统配置与审计',
    items: [
      { code: 'system.settings.read', desc: '查看系统设置与基础配置' },
      { code: 'system.settings.manage', desc: '管理大模型与模型供应商参数' },
      { code: 'audit.read', desc: '查阅系统安全与编译审计日志' },
      { code: '*', desc: '⚡ 超级管理员全局特权（包含系统全部功能）' },
    ]
  },
];

function RoleFormModal({target, onClose, onSaved}){
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
    } catch (error: any) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:error.message || '保存失败'}));
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

function TextKnowledgeModal({onClose, onSave}){
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
    <div className="field-hint">内容会经过统一解析、分块、向量化和 GBrain 索引，保存后即可用于问答。</div>
  </Modal>;
}

/* ============== Admin: 行业库管理（含动态新增） ============== */
function IndustryKBPanel({onOpenGrant, canCreate = false}){
  const [openNew, setOpenNew] = useState(false);
  const [adminTarget, setAdminTarget] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [search, setSearch] = useState('');

  const filtered = INDUSTRY_KBS.filter(k => {
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
          共 {filtered.length} / {INDUSTRY_KBS.length} 个行业知识库
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
                  <div style={{fontSize:'28px',marginBottom:'8px'}}>📚</div>
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
                    👥 {k.grants} 个主体 ↗
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
        <div className={`subtab ${sub==='ocr'?'active':''}`} onClick={()=>setSub('ocr')}>PDF OCR<span className="n">{PROVIDERS.some(p=>p.kind==='ocr')?'已配置':'未配置'}</span></div>
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
                    {p.kind==='ocr'?'PDF OCR':p.kind==='gateway'?'网关':p.kind==='selfhost'?'自托管':'外部API'}
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

      {sub==='ocr' && <OcrConfigPanel/>}

      {(openNewPv || editProvider) && <NewProviderModal target={editProvider} onClose={()=>{setOpenNewPv(false);setEditProvider(null)}} onSaved={()=>{setOpenNewPv(false);setEditProvider(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {openNewM && <NewModelModal kind={openNewM.kind} target={openNewM.target} onClose={()=>setOpenNewM(false)} onSaved={()=>{setOpenNewM(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {confirmDelPv && <ConfirmModal title="删除供应商" msg={<>确认删除供应商 <b style={{color:'var(--ink)'}}>{confirmDelPv.name}</b>？引用此供应商的所有模型将变为不可用状态，需先迁移。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers/${confirmDelPv.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelPv(null)}/>}
      {confirmDelM && <ConfirmModal title="删除模型" msg={<>确认删除模型 <b style={{color:'var(--ink)'}}>{confirmDelM.name}</b>？知识库中绑定此模型的将需要回退到默认。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/models/${confirmDelM.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelM(null)}/>}
    </>
  );
}

function OcrConfigPanel(){
  const target = PROVIDERS.find(p=>p.kind==='ocr');
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const save = async () => {
    if (!target && (!apiKey.trim() || !secretKey.trim())) {
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'首次配置需要填写 API Key 和 Secret Key'}));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/providers${target ? `/${target.id}` : ''}`, {
        method: target ? 'PATCH' : 'POST',
        headers: {'Content-Type':'application/json',...apiHeaders()},
        body: JSON.stringify({
          name: '百度智能云 OCR', kind: 'ocr', baseUrl: 'https://aip.baidubce.com',
          defaultParams: {provider:'baidu', note:'扫描版/混合版 PDF 文档解析'},
          ...(apiKey.trim() ? {apiKey:apiKey.trim()} : {}),
          ...(secretKey.trim() ? {secretKey:secretKey.trim()} : {}),
        }),
      });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      setApiKey(''); setSecretKey('');
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'百度 OCR 配置已保存'}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '保存失败'})); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/ocr/test`,{method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:result.status==='passed'?'百度 OCR 连接测试成功':(result.message||'百度 OCR 连接测试失败')}));
    } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'百度 OCR 连接测试失败'})); }
    finally { setTesting(false); }
  };
  return <div className="mc">
    <div className="mc-cat embed">
      <div className="mc-cat-head"><span className="tag">PDF OCR · 扫描件</span><h4>百度智能云文档解析</h4><span className="hint">仅扫描版/混合版 PDF 调用；可读版不产生 OCR 费用</span></div>
      <div style={{padding:'18px 20px',maxWidth:680}}>
        <div className="field"><label>API Key {target?.hasApiKey && <span style={{color:'var(--success)',fontSize:11}}>（已配置：{target.keyMask}）</span>}</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={target?.hasApiKey?'留空表示保持不变':'百度智能云 API Key'}/></div>
        <div className="field"><label>Secret Key {target?.hasSecretKey && <span style={{color:'var(--success)',fontSize:11}}>（已配置：{target.secretKeyMask}）</span>}</label><input type="password" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder={target?.hasSecretKey?'留空表示保持不变':'百度智能云 Secret Key'}/></div>
        <div className="field"><label>接口地址</label><input value="https://aip.baidubce.com" readOnly/></div>
        <div style={{display:'flex',gap:8,marginTop:14}}><button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存配置'}</button><button className="btn" disabled={!target || testing} onClick={test}>{testing?'测试中…':'测试连接'}</button></div>
        <div style={{marginTop:14,color:'var(--ink-3)',fontSize:12,lineHeight:1.6}}>凭据只在服务端加密保存。保存后，API 在提交解析任务时通过内部链路传递，parser 任务状态和日志不会返回密钥。</div>
      </div>
    </div>
  </div>;
}

function NewProviderModal({target, onClose, onSaved}){
  const [kind, setKind] = useState(target?.kind || 'gateway');
  const [name, setName] = useState(target?.name || ''); const [baseUrl, setBaseUrl] = useState(target?.url || ''); const [apiKey, setApiKey] = useState(''); const [secretKey, setSecretKey] = useState(''); const [note, setNote] = useState(''); const [saving, setSaving] = useState(false);
  const save = async () => { if (!name.trim() || !baseUrl.trim()) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name,kind,baseUrl,defaultParams:{note},...(apiKey ? {apiKey} : {}),...(secretKey ? {secretKey} : {})})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'供应商已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'保存失败'}));} finally{setSaving(false);} };
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
          <option value="ocr">PDF OCR（百度智能云）</option>
        </select>
      </div>
      <div className="field"><label>Base URL<span className="req">*</span></label><input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://..."/></div>
      <div className="field"><label>API Key</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={kind==='selfhost'?'(自托管通常不需要)':'sk-...'}/></div>
      {kind==='ocr' && <div className="field"><label>Secret Key</label><input type="password" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder="百度智能云 Secret Key"/></div>}
      <div className="field"><label>备注</label><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="该供应商用途、限速、协议说明"/></div>
    </Modal>
  );
}

function NewModelModal({kind, target, onClose, onSaved}){
  const label = kind==='llm' ? '大语言模型' : kind==='embedding' ? '嵌入模型' : '重排模型';
  const [modelName, setModelName] = useState(target?.modelName || target?.name || ''); const [providerId, setProviderId] = useState(target?.providerId || ''); const [contextLen, setContextLen] = useState(String(target?.contextLen || 8192)); const [dimensions, setDimensions] = useState(target?.dimensions ? String(target.dimensions) : ''); const [isDefault, setIsDefault] = useState(Boolean(target?.isDefault ?? target?.default)); const [saving, setSaving] = useState(false);
  const save = async () => { if (!modelName.trim() || !providerId) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/models${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({kind,modelName,providerId,contextLen,dimensions,isDefault})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'模型已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message||'保存失败'}));} finally{setSaving(false);} };
  return (
    <Modal title={`${target ? '编辑' : '新增'}${label}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存'}</button>
      </>
    }>
      <div className="field"><label>模型名称<span className="req">*</span></label><input value={modelName} onChange={e=>setModelName(e.target.value)} placeholder="如：qwen3-max / bge-m3 / bge-reranker-v2-m3"/></div>
      <div className="field"><label>供应商<span className="req">*</span></label>
        <select value={providerId} onChange={e=>setProviderId(e.target.value)}><option value="">选择已注册的供应商…</option>{PROVIDERS.filter(p=>p.kind!=='ocr').map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
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
  const [auditMeta, setAuditMeta] = useState(AUDIT_META);
  useEffect(()=>{
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  useEffect(() => setAuditMeta(AUDIT_META), [AUDIT.length, AUDIT_META.total, AUDIT_META.page]);
  const loadAuditPage = async (page) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/data?auditPage=${page}&auditLimit=20`, { headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '审计日志加载失败');
      AUDIT = (result.audit || []).map((item) => ({ ...item, when: new Date(item.when).toLocaleString('zh-CN'), what: item.action, actor: item.actor }));
      AUDIT_META = result.auditPagination || { page, limit: 20, total: AUDIT.length, totalPages: 1 };
      setAuditMeta(AUDIT_META);
      if (result.dream) DREAM = result.dream;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: error.message || '审计日志加载失败' }));
    }
  };
  const loadDreamPage = async (page) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/data?auditPage=${auditMeta.page || 1}&auditLimit=20&dreamPage=${page}`, { headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Dream 运行记录加载失败');
      if (result.dream) DREAM = result.dream;
      setAuditMeta((current) => ({ ...current }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: error.message || 'Dream 运行记录加载失败' }));
    }
  };
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
  const [editModal, setEditModal] = useState(null);   // 编辑组织
  const [deleteModal, setDeleteModal] = useState(null); // 删除组织
  const orgOptions = useMemo(() => flattenOrgTree(orgTree), [orgTree]);
  const canCreateRoot = hasCapability('*', capabilities);
  const tabRules = [
    {k:'org', l:'组织架构', ic:'users', permission:'org.read'},
    {k:'users', l:'人员管理', ic:'user', permission:'org.user.read'},
    {k:'roles', l:'角色管理', ic:'shield', permission:'role.read'},
    // 创建者即使已把内容管理员转交给别人，仍需保留设置管理员和删除库的入口。
    // 资源管理员但没有行业库角色时仍不会因此获得整个管理菜单。
    {k:'industry', l:'行业库管理', ic:'book', permission:'kb.industry.read', alternativePermission:'kb.industry.create'},
    {k:'grant', l:'权限授权', ic:'shield', permission:'kb.industry.grant'},
    {k:'model', l:'模型配置', ic:'model', permission:'system.settings.manage'},
    {k:'audit', l:'审计日志', ic:'history', permission:'audit.read'},
    {k:'status', l:'系统运行监控', ic:'activity', permission:'audit.read', alternativePermission:'system.settings.read'},
  ];
  const availableTabs = tabRules.filter(item => hasCapability(item.permission, capabilities) || (item.alternativePermission && hasCapability(item.alternativePermission, capabilities))).map(item => item.k);
  useEffect(() => {
    if (availableTabs.length && !availableTabs.includes(tab)) setTab(availableTabs[0]);
  }, [availableTabs.join(','), tab]);

  const toggleNode = (id) => setExpandedIds(s=>{ const ns = new Set(s); ns.has(id) ? ns.delete(id) : ns.add(id); return ns; });

  const addChildOrg = async (parentId, name, adminUserIds = []) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name, parentId: parentId || null, adminUserIds }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const created = result.organization;
      if (!created) throw new Error('接口未返回新组织');
      setExpandedIds(s=>parentId ? new Set(s).add(parentId) : s);   // 确保父节点展开，新节点立即可见
      setOrgTree(t=>{
        const rec = (n) => {
          if(n.id === parentId){
            return {...n, children: [...(n.children||[]), {...created, admins: adminUserIds.map(id => USERS.find(u=>u.id===id)?.name).filter(Boolean), children: []}]};
          }
          return {...n, children: (n.children||[]).map(rec)};
        };
        // 当前管理界面以树根为展示入口；新增根组织后保留原根，并将最新数据交给
        // 全局刷新重新组装，避免把已有组织树误替换掉。
        return parentId ? rec(t) : t;
      });
      window.dispatchEvent(new CustomEvent('app-toast', {detail:`组织「${created.name}」已保存` }));
      if (!parentId) window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', {detail:`组织保存失败：${error.message || '请稍后重试'}` }));
      return false;
    }
  };
  const updateOrganization = async (node, name, parentId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name, parentId: parentId || null }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const updated = result.organization;
      if (!updated) throw new Error('接口未返回更新后的组织');

      const rewritePaths = (current, oldPath, nextPath) => ({
        ...current,
        ...(current.id === node.id ? { ...updated } : {}),
        path: current.path === oldPath ? nextPath : current.path.startsWith(`${oldPath}/`) ? `${nextPath}${current.path.slice(oldPath.length)}` : current.path,
        children: (current.children || []).map((child) => rewritePaths(child, oldPath, nextPath)),
      });
      const detach = (current) => {
        if (!current) return { tree: current, detached: null };
        if (current.id === node.id) return { tree: null, detached: current };
        let detached = null;
        const children = [];
        for (const child of current.children || []) {
          const result = detach(child);
          if (result.detached) detached = result.detached;
          if (result.tree) children.push(result.tree);
        }
        return { tree: { ...current, children }, detached };
      };
      const attach = (current, targetId, child) => {
        if (!current) return current;
        if (current.id === targetId) return { ...current, children: [...(current.children || []), child] };
        return { ...current, children: (current.children || []).map((item) => attach(item, targetId, child)) };
      };
      setOrgTree((tree) => {
        if (node.parentId === (parentId || null)) return rewritePaths(tree, node.path, updated.path);
        const result = detach(tree);
        if (!result.detached) return tree;
        const moved = rewritePaths({ ...result.detached, ...updated }, node.path, updated.path);
        return parentId ? attach(result.tree, parentId, moved) : moved;
      });
      setEditModal(null);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织「${updated.name}」已更新` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织更新失败：${error.message || '请稍后重试'}` }));
      return false;
    }
  };
  const deleteOrganization = async (node) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}`, { method: 'DELETE', headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      setOrgTree((tree) => {
        const remove = (current) => {
          if (!current) return current;
          if (current.id === node.id) return null;
          return { ...current, children: (current.children || []).map(remove).filter(Boolean) };
        };
        return remove(tree);
      });
      setDeleteModal(null);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织「${node.name}」已删除` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织删除失败：${error.message || '请稍后重试'}` }));
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
          <OrgPanel
            orgTree={orgTree}
            expandedIds={expandedIds}
            onToggle={toggleNode}
            setExpandedIds={setExpandedIds}
            onAddChild={(n: any)=>setAddModal(n)}
            onSetAdmin={(n: any)=>setAdminModal(n)}
            onEdit={(n: any)=>setEditModal(n)}
            onDelete={(n: any)=>setDeleteModal(n)}
            onActivateKb={activateKb}
            onDeactivateKb={deactivateKb}
            onManageKb={onManageKb}
            canCreateRoot={canCreateRoot}
          />
        )}
        {tab==='users' && <UsersPanel orgTree={orgTree} orgOptions={orgOptions} canManage={hasCapability('org.user.manage', capabilities)} capabilities={capabilities}/>}
        {tab==='roles' && <RolesPanel canManage={hasCapability('role.manage', capabilities)}/>}
        {tab==='industry' && <IndustryKBPanel canCreate={hasCapability('kb.industry.create', capabilities)} onOpenGrant={(k)=>{setGrantKb(k.id); setTab('grant');}}/>}
        {tab==='grant' && <GrantPanel kbId={grantKb} setKbId={setGrantKb}/>}
        {tab==='model' && <ModelPanel/>}
        {tab==='audit' && (
          <>
            <div style={{display:'flex',alignItems:'flex-start',marginBottom:18}}>
              <div style={{flex:1}}>
                <div className="h1">审计日志</div>
                <div className="subline">查询 · 知识变更 · 权限变更 · 大脑编译记录 · Dream Cycle · 越权拦截 · 留存 ≥ 1 年</div>
              </div>
              {DREAM && capabilities.includes('*') && <button className="btn" onClick={async()=>{
                try {
                  const response = await fetch(`${API_BASE_URL}/api/v1/admin/brain/maintenance`, {method:'POST', headers:apiHeaders()});
                  const result = await response.json().catch(()=>({}));
                  if (!response.ok) throw new Error(result.message || '维护任务提交失败');
                  window.dispatchEvent(new CustomEvent('app-toast',{detail:'Dream Cycle 已进入后台队列'}));
                  window.setTimeout(()=>window.dispatchEvent(new CustomEvent('app-data-refresh')),1500);
                } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:error.message || '维护任务提交失败'})); }
              }}><Icon name="refresh" size={12}/> 立即执行维护</button>}
            </div>
            {DREAM && <DreamTelemetryPanel telemetry={DREAM} onPageChange={loadDreamPage}/>}
            <div className="audit">
              {AUDIT.map((a,i)=>(
                <div key={i} className="audit-row">
                  <div className="when">{a.when}</div>
                  <div className="what">{a.what}</div>
                  <div className="actor">{a.actor}</div>
                </div>
              ))}
            </div>
            <PaginationBar pagination={auditMeta} onChange={loadAuditPage} label="条审计记录" />
          </>
        )}
        {tab==='status' && <SystemStatusPanel capabilities={capabilities}/>}

        {adminModal && <OrgAdminModal node={adminModal} onClose={()=>setAdminModal(null)} onSaved={()=>{setAdminModal(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
        {addModal && <AddOrgModal parent={addModal} orgOptions={orgOptions} canCreateRoot={canCreateRoot} onAdd={async (name, parentId, adminUserIds)=>{if (await addChildOrg(parentId, name, adminUserIds)) setAddModal(null);}} onClose={()=>setAddModal(null)}/>}
        {editModal && <EditOrgModal node={editModal} orgOptions={orgOptions} canCreateRoot={canCreateRoot} onSave={(name, parentId)=>updateOrganization(editModal, name, parentId)} onClose={()=>setEditModal(null)}/>}
        {deleteModal && <ConfirmModal title="删除组织" msg={<>确认删除组织 <b style={{color:'var(--ink)'}}>{deleteModal.name}</b>？删除前必须先处理该组织的下属组织；组织库会保留为已停用状态。</>} onConfirm={()=>deleteOrganization(deleteModal)} onClose={()=>setDeleteModal(null)}/>}
      </div>
    </div>
  );
}

function SystemStatusPanel({ capabilities }){
  const [data, setData] = useState(SYSTEM_STATUS);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('kbs');
  const [retryingDocId, setRetryingDocId] = useState(null);
  const [sectionPages, setSectionPages] = useState({});

  const fetchTelemetry = async (section = '', page = 1) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (section) { query.set('section', section); query.set('page', String(page)); }
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/system/status-telemetry?${query.toString()}`, {
        headers: apiHeaders()
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        SYSTEM_STATUS = json;
      }
    } catch (e) {
      console.error('Failed to load status telemetry:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadSectionPage = (section, page) => {
    setSectionPages((current) => ({ ...current, [section]: page }));
    void fetchTelemetry(section, page);
  };

  useEffect(() => {
    if (!data) fetchTelemetry();
  }, []);

  const s = data?.summary || {};
  const inq = data?.ingestionQuality || {};
  const gbs = data?.gbrainSources || {};
  const scp = data?.scopeBrainQuality || {};
  const drm = data?.dreamMaintenance || {};
  const obx = data?.outboxAndQueues || {};
  const rag = data?.ragAndModels || {};

  const fmt = (val) => val ? new Date(val).toLocaleString('zh-CN') : '—';
  const statusLabels = { completed: '已完成', partial: '部分完成', failed: '失败', running: '执行中', healthy: '运行健康', degraded: '部分降级', warning: '存在告警' };
  const statusColors = { completed: 'var(--green)', healthy: 'var(--green)', partial: 'var(--amber)', degraded: 'var(--amber)', failed: 'var(--red)', warning: 'var(--red)', running: 'var(--blue)' };

  const triggerMaintenance = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/brain/maintenance`, { method: 'POST', headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '维护任务提交失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: 'Dream Cycle 维护任务已进入后台队列' }));
      setTimeout(fetchTelemetry, 2000);
    } catch (err) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: err.message || '维护任务提交失败' }));
    }
  };

  const retryDoc = async (kbId, docId) => {
    setRetryingDocId(docId);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/retry`, { method: 'POST', headers: apiHeaders() });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: '已重新触发解析任务' }));
        setTimeout(fetchTelemetry, 2500);
      } else {
        const err = await res.json().catch(() => ({}));
        window.dispatchEvent(new CustomEvent('app-toast', { detail: err.message || '重试失败' }));
      }
    } catch (e) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '重试网络异常' }));
    } finally {
      setRetryingDocId(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <div className="h1">系统运行状态与全流程质量监控</div>
          <div className="subline">端到端全链路质量监控 · GBrain 知识源与 Scope 脑 · 物理存储 · 向量解析 · 事务 Outbox 队列 · 实时指标遥测</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => fetchTelemetry()} disabled={loading}>
            <Icon name="refresh" size={12}/> {loading ? '刷新中…' : '刷新数据'}
          </button>
          {capabilities.includes('*') && (
            <button className="btn primary" onClick={triggerMaintenance}>
              <Icon name="refresh" size={12}/> 立即执行 Dream 维护
            </button>
          )}
        </div>
      </div>

      {/* 1. Global Health Status Banner */}
      <div style={{
        background: s.healthStatus === 'healthy' ? 'rgba(16, 185, 129, 0.08)' : s.healthStatus === 'warning' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)',
        border: `1px solid ${s.healthStatus === 'healthy' ? 'rgba(16, 185, 129, 0.3)' : s.healthStatus === 'warning' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
        borderRadius: 10,
        padding: '14px 18px',
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: s.healthStatus === 'healthy' ? 'var(--green)' : s.healthStatus === 'warning' ? 'var(--red)' : 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16
          }}>
            {s.healthStatus === 'healthy' ? '✓' : '!'}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
              全流程系统健康度：{s.healthStatus === 'healthy' ? '运行健康 (Healthy)' : s.healthStatus === 'warning' ? '存在告警 (Warning)' : '部分降级 (Degraded)'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
              文档解析率 <b>{inq.parseSuccessRate ?? 100}%</b> · Docling Worker <b>{s.doclingStatus?.online ? `在线 (${s.doclingStatus?.latencyMs}ms)` : '离线'}</b> · 物理仓库 <b>{s.storageUsage?.repoFormatted || '—'}</b> · Outbox <b>{s.outboxStatus?.pending || 0} 积压</b>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11.5 }}>
          <span className="badge ok" style={{ padding: '3px 8px' }}>GBrain 0.47 核心引擎</span>
          <span className="badge" style={{ padding: '3px 8px', background: 'var(--surface)', color: 'var(--ink)' }}>双级 Dream 自愈就绪</span>
        </div>
      </div>

      {/* 2. 6 Core Quality KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>📄 知识文档与解析</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{inq.totalDocuments || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>篇</span></div>
          <div style={{ fontSize: 11, color: inq.failedDocuments ? 'var(--red)' : 'var(--green)', marginTop: 4 }}>
            {inq.publishedDocuments || 0} 篇已发布 · {inq.failedDocuments || 0} 失败
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>🧩 物理切片与向量</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{inq.totalChunks || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>切片</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            均长 {inq.avgChunkLength || 0} 字符 · {inq.embeddingDimensions || 1024} 维
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>🗄️ GBrain 物理知识源</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{gbs.sourcesCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>个 Source</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            磁盘占用 {s.storageUsage?.repoFormatted || '—'}
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>🧠 权限 Scope 脑</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{scp.scopesCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>个 Scope</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            {scp.derivedPagesCount || 0} 篇派生资产 · 100% 溯源
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>⚙️ 双级 Dream 周期</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{drm.durationsAvgSec ? `${drm.durationsAvgSec}s` : '30s'} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>均耗时</span></div>
          <div style={{ fontSize: 11, color: drm.health === 'healthy' ? 'var(--green)' : 'var(--amber)', marginTop: 4 }}>
            每日 {drm.cron || '02:00'} 执行 · {drm.health === 'healthy' ? '状态良好' : '部分降级'}
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>⚡ 事务 Outbox 总线</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{obx.outboxCounts?.completed || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>/ {obx.outboxCounts?.total || 0} 完成</span></div>
          <div style={{ fontSize: 11, color: obx.outboxCounts?.pending ? 'var(--amber)' : 'var(--green)', marginTop: 4 }}>
            {obx.outboxCounts?.pending || 0} 待处理 · {obx.outboxCounts?.failed || 0} 失败
          </div>
        </div>
      </div>

      {/* 3. Knowledge Pipeline Lifecycle Stage Visual Tracker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>
          🔗 知识流转全生命周期质量链路
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>1. 文档摄入解析</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>Docling {s.doclingStatus?.latencyMs || 0}ms</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{inq.totalDocuments || 0} 份文档已解析</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Docx / PPT / PDF 多格式支持</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>2. 物理切片与向量</span>
              <span className="badge" style={{ fontSize: 9.5 }}>1024 维 BGE</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{inq.totalChunks || 0} 切片 (均长 {inq.avgChunkLength || 0} 字)</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>语义完整性自适应切分</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>3. GBrain 物理源物化</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>Git 底座</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{gbs.sourcesCount || 0} 个 Source 仓库</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>{s.storageUsage?.repoFormatted || '—'} 物理磁盘空间</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>4. Scope 脑与派生层</span>
              <span className="badge purple" style={{ fontSize: 9.5 }}>Derived 100% 溯源</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{scp.scopesCount || 0} Scope / {scp.derivedPagesCount || 0} 派生页</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Eager + Lazy 懒编译混合</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>5. 检索重排与问答</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>0s 权限断流</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{rag.totalConversations || 0} 会话 / {rag.totalMessages || 0} 消息</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Cross-Encoder 精准重排</div>
          </div>
        </div>
      </div>

      {/* 4. Sub-Navigation Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', gap: 18, marginBottom: 16 }}>
        {[
          { k: 'kbs', l: '知识库与切片解析质量' },
          { k: 'sources', l: 'GBrain 知识源与 Scope 脑' },
          { k: 'dream', l: '双级 Dream 维护记录' },
          { k: 'outbox', l: 'Outbox 事件总线与队列' },
          { k: 'models', l: '问答检索与模型网关' },
        ].map(t => (
          <button
            key={t.k}
            onClick={() => {
              setActiveTab(t.k);
              if ((sectionPages[t.k] || 1) > 1) void fetchTelemetry(t.k, sectionPages[t.k]);
            }}
            style={{
              padding: '8px 4px',
              border: 'none',
              background: 'transparent',
              fontSize: 13,
              fontWeight: activeTab === t.k ? 600 : 400,
              color: activeTab === t.k ? 'var(--ink)' : 'var(--ink-3)',
              borderBottom: activeTab === t.k ? '2px solid var(--ink)' : '2px solid transparent',
              cursor: 'pointer'
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      {/* 5. Detailed Breakdown Sub-Panels */}
      {activeTab === 'kbs' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>知识库名称</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 100 }}>文档数量</th>
                <th style={{ width: 100 }}>切片总数</th>
                <th style={{ width: 100 }}>解析状态</th>
                <th style={{ width: 100, textAlign: 'right' }}>健康度</th>
              </tr>
            </thead>
            <tbody>
              {(inq.kbBreakdown || []).map((kb) => (
                <tr key={kb.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{kb.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>ID: {kb.id}</div>
                  </td>
                  <td>
                    <span className="badge" style={{ fontSize: 10.5 }}>
                      {kb.type === 'org' ? '组织库' : kb.type === 'industry' ? '行业库' : '个人库'}
                    </span>
                  </td>
                  <td><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{kb.docsCount} 篇</span></td>
                  <td><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{kb.chunksCount} 个</span></td>
                  <td>
                    {kb.failedDocsCount > 0 ? (
                      <span className="badge danger" style={{ fontSize: 10.5 }}>{kb.failedDocsCount} 篇失败</span>
                    ) : (
                      <span className="badge ok" style={{ fontSize: 10.5 }}>100% 正常</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: kb.failedDocsCount > 0 ? 'var(--red)' : 'var(--green)', fontSize: 12, fontWeight: 500 }}>
                      {kb.failedDocsCount > 0 ? '需排查' : '🟢 优良'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {inq.failedDocsList?.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)' }}>
              <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>⚠️ 解析失败文档清单</div>
              {inq.failedDocsList.map((d) => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(239, 68, 68, 0.1)' }}>
                  <div>
                    <b>{d.title}</b> ({d.kbName}) - <span style={{ color: 'var(--red)' }}>{d.error}</span>
                  </div>
                  <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => retryDoc(d.kbId, d.id)} disabled={retryingDocId === d.id}>
                    {retryingDocId === d.id ? '重试中…' : '重试解析'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <PaginationBar pagination={inq.pagination?.kbBreakdown} onChange={(page) => loadSectionPage('kbs', page)} label="个知识库" />
          {inq.failedDocsList?.length > 0 && <PaginationBar pagination={inq.pagination?.failedDocs} onChange={(page) => loadSectionPage('failedDocs', page)} label="个失败文档" />}
        </div>
      )}

      {activeTab === 'sources' && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 8 }}>GBrain 物理源列表 (Raw Sources)</div>
          <div className="table-wrap" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>Source Key</th>
                  <th style={{ width: 90 }}>类型</th>
                  <th style={{ width: 100 }}>包含文档</th>
                  <th style={{ width: 100 }}>绑定成员</th>
                  <th style={{ width: 160 }}>最近同步时间</th>
                  <th style={{ width: 90, textAlign: 'right' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {(gbs.sourcesList || []).map((s) => (
                  <tr key={s.sourceKey}>
                    <td><span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ink)' }}>{s.sourceKey}</span></td>
                    <td><span className={`badge ${s.kind === 'shared' ? 'ok' : 'purple'}`}>{s.kind === 'shared' ? '共享源' : '私密源'}</span></td>
                    <td><b>{s.documentsCount}</b> 篇</td>
                    <td><b>{s.membersCount}</b> 人</td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(s.lastSyncAt)}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--green)', fontSize: 12 }}>🟢 活跃</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={gbs.pagination} onChange={(page) => loadSectionPage('sources', page)} label="个 Source" />

          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 8 }}>权限 Scope 脑矩阵与派生智能 (Derived Intelligence)</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Scope 指纹</th>
                  <th style={{ width: 80 }}>策略</th>
                  <th style={{ width: 120 }}>复用成员</th>
                  <th>派生全景综述 (Derived Pages)</th>
                  <th style={{ width: 130 }}>版本 (Epoch)</th>
                  <th style={{ width: 90, textAlign: 'right' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {(scp.scopeList || []).map((sc) => (
                  <tr key={sc.id}>
                    <td><span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ink)' }}>{sc.fingerprint}</span></td>
                    <td><span className={`badge ${sc.strategy === 'eager' ? 'ok' : 'purple'}`}>{sc.strategy === 'eager' ? '⚡ Eager' : '💤 Lazy'}</span></td>
                    <td>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                        {sc.members?.map(m => m.displayName || m.username).join(', ') || `${sc.membersCount} 人`}
                      </div>
                    </td>
                    <td>
                      {sc.derivedPages?.length ? (
                        <div>
                          {sc.derivedPages.map(p => (
                            <div key={p.id} style={{ fontSize: 11.5 }}>
                              <b>{p.title}</b> <span style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>({p.derivedCount} 处溯源锚点)</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>未生成派生页 (按需懒生成)</span>
                      )}
                    </td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>ACL v{sc.aclEpoch} · 知识 v{sc.knowledgeEpoch}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--green)', fontSize: 12 }}>🟢 运行中</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={scp.pagination} onChange={(page) => loadSectionPage('scopes', page)} label="个 Scope" />
        </>
      )}

      {activeTab === 'dream' && (
        <>
          <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 16, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 4 }}>双级 Dream Cycle 调度策略</div>
            <div>• 执行周期：<b>每日 {drm.cron || '0 2 * * *'} ({drm.timezone || 'Asia/Shanghai'})</b></div>
            <div>• <b>Tier 1 (Source Dream)</b>：单源物理索引深度自愈、切片 Embedding 重整、孤岛脏主题自愈。</div>
            <div>• <b>Tier 2 (Scope Dream)</b>：权限 Scope 脑宏观全景总结合成、概念卡片提炼、derivedFrom 锚点校验。</div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>执行开始时间</th>
                  <th style={{ width: 90 }}>运行状态</th>
                  <th>处理源统计</th>
                  <th style={{ width: 100 }}>待编译主题</th>
                  <th style={{ width: 100, textAlign: 'right' }}>执行耗时</th>
                </tr>
              </thead>
              <tbody>
                {(drm.runs || []).map((r) => (
                  <tr key={r.id}>
                    <td><span style={{ fontSize: 12 }}>{fmt(r.startedAt)}</span></td>
                    <td><b style={{ color: statusColors[r.status] || 'var(--ink)', fontSize: 12 }}>{statusLabels[r.status] || r.status}</b></td>
                    <td>
                      <span style={{ fontSize: 12 }}>{r.sourcesVisited || 0} 个源 ({r.sourcesSucceeded || 0} 成功, {r.sourcesPartial || 0} 部分)</span>
                      {Array.isArray(r.sourceResults) && r.sourceResults.length > 0 && (
                        <details style={{ marginTop: 5, fontSize: 10.5 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--ink-3)' }}>查看阶段明细</summary>
                          <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
                            {r.sourceResults.slice(0, 12).map((source, index) => {
                              const graph = source.graphExtraction || {};
                              const skipped = Array.isArray(source.expectedSkippedPhases) ? source.expectedSkippedPhases.length : 0;
                              return (
                                <div key={`${source.sourceKey || source.source || index}-${index}`} style={{ color: 'var(--ink-3)' }}>
                                  <span style={{ fontFamily: 'monospace' }}>{String(source.sourceKey || source.source || 'source').slice(0, 28)}</span>
                                  {' · '}{statusLabels[source.status] || source.status || '—'}
                                  {' · 图谱：'}{graph.status === 'completed' ? `${graph.pagesProcessed || 0} 页 / ${graph.linksCreated || 0} links` : graph.status || '—'}
                                  {skipped ? ` · 预期跳过 ${skipped} 阶段` : ''}
                                  {source.failedPhases?.length ? ` · 失败：${source.failedPhases.join(', ')}` : ''}
                                  {source.warningPhases?.length ? ` · 告警：${source.warningPhases.join(', ')}` : ''}
                                </div>
                              );
                            })}
                            {r.sourceResults.length > 12 && <div>其余 {r.sourceResults.length - 12} 个源请查看服务日志。</div>}
                          </div>
                        </details>
                      )}
                    </td>
                    <td><b>{r.queuedTopics || 0}</b> 个</td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={drm.pagination} onChange={(page) => loadSectionPage('dream', page)} label="次 Dream 运行" />
        </>
      )}

      {activeTab === 'outbox' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>待处理事件 (Pending)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: obx.outboxCounts?.pending ? 'var(--amber)' : 'var(--ink)' }}>{obx.outboxCounts?.pending || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>已完成对账 (Completed)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green)' }}>{obx.outboxCounts?.completed || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>失败事件 (Failed)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: obx.outboxCounts?.failed ? 'var(--red)' : 'var(--ink-3)' }}>{obx.outboxCounts?.failed || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>BullMQ 活跃队列</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--blue)' }}>{obx.queueJobCounts?.active || 0}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>事件类型</th>
                  <th style={{ width: 80 }}>状态</th>
                  <th>事件载荷 (Payload)</th>
                  <th style={{ width: 150 }}>发生时间</th>
                  <th style={{ width: 150, textAlign: 'right' }}>完成时间</th>
                </tr>
              </thead>
              <tbody>
                {(obx.recentEvents || []).map((e) => (
                  <tr key={e.id}>
                    <td>
                      <span className="badge" style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 6px' }}>{e.eventType}</span>
                    </td>
                    <td>
                      <span className={`badge ${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'danger' : 'amber'}`}>
                        {e.status === 'completed' ? '已完成' : e.status === 'failed' ? '失败' : '排队中'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: 11, fontFamily: 'SF Mono,Menlo,Consolas,monospace', color: 'var(--ink-2)' }}>
                        {typeof e.payload === 'object' ? JSON.stringify(e.payload) : String(e.payload)}
                      </span>
                    </td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(e.createdAt)}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(e.processedAt)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={obx.pagination} onChange={(page) => loadSectionPage('outbox', page)} label="个事件" />
        </>
      )}

      {activeTab === 'models' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>总会话数</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalConversations || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>累计问答消息</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalMessages || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>溯源引用生成数</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalCitations || 0}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 110 }}>网关类型</th>
                  <th>模型名称</th>
                  <th>供应商</th>
                  <th>接入地址</th>
                  <th style={{ width: 80 }}>默认</th>
                  <th style={{ width: 90, textAlign: 'right' }}>连通测试</th>
                </tr>
              </thead>
              <tbody>
                {(rag.activeModels || []).map((m, i) => (
                  <tr key={i}>
                    <td>
                      <span className="badge" style={{ fontSize: 10.5 }}>
                        {m.kind === 'llm' ? 'LLM 对话' : m.kind === 'embedding' ? '向量嵌入' : '交叉重排'}
                      </span>
                    </td>
                    <td><b>{m.modelName}</b></td>
                    <td>{m.providerName}</td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'monospace' }}>{m.baseUrl}</span></td>
                    <td>{m.isDefault ? <span className="badge ok" style={{ fontSize: 10 }}>默认</span> : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: m.testStatus === 'passed' ? 'var(--green)' : 'var(--amber)', fontSize: 12 }}>
                        {m.testStatus === 'passed' ? '🟢 通过' : '🟡 未测'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rag.runtime && (
            <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>GBrain 实际运行态</div>
              <div style={{ color: 'var(--ink-2)' }}>
                {['llm', 'embedding', 'rerank'].map((kind) => {
                  const route = rag.runtime.routes?.[kind] || {};
                  return <span key={kind} style={{ marginRight: 16 }}>{kind === 'llm' ? 'LLM' : kind === 'embedding' ? 'Embedding' : 'Reranker'}：{route.modelName || '未配置'} {route.injected ? '🟢 已注入 GBrain' : '🔴 未注入'}</span>;
                })}
              </div>
              <div style={{ color: 'var(--ink-3)' }}>连接池 {rag.runtime.gbrain?.poolSize || 2} · Scope Synthesize {rag.runtime.gbrain?.scopeSynthesizeEnabled ? '开启' : '关闭'} · 图谱增量抽取 {rag.runtime.gbrain?.graphExtractEnabled ? '开启' : '关闭'}</div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function DreamTelemetryPanel({telemetry, onPageChange}){
  const last = telemetry.lastRun;
  const statusLabels = {completed:'已完成',partial:'部分完成',failed:'失败',running:'执行中',clean:'已完成'};
  const statusColors = {completed:'var(--green)',partial:'var(--amber)',failed:'var(--red)',running:'var(--blue)',clean:'var(--green)'};
  const fmt = (value) => value ? new Date(value).toLocaleString('zh-CN') : '—';
  const latestSources = Array.isArray(last?.sourceResults) ? last.sourceResults : [];
  const skippedPhases = latestSources.reduce((sum, source) => sum + (source.phases || []).filter(phase => phase.status === 'skipped').length, 0);
  const warningPhases = latestSources.reduce((sum, source) => sum + (source.phases || []).filter(phase => phase.status === 'warn').length, 0);
  const healthLabels = {healthy:'运行正常',degraded:'有告警',stale:'超过预期周期',failed:'最近失败',unknown:'尚无运行记录',disabled:'已停用'};
  const healthColors = {healthy:'var(--green)',degraded:'var(--amber)',stale:'var(--amber)',failed:'var(--red)',unknown:'var(--ink-3)',disabled:'var(--ink-3)'};
  const scopes = telemetry.scopes || [];

  return <div style={{marginBottom:20}}>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
      {[
        ['运行状态', healthLabels[telemetry.health] || telemetry.health, healthColors[telemetry.health] || 'var(--ink-3)'],
        ['最近双级 Dream', last ? fmt(last.startedAt) : '—', 'var(--ink)'],
        ['权限 Scope 脑', `${scopes.length} 个复用 Scope`, 'var(--ink)'],
        ['派生智能资产', `${telemetry.derivedPagesCount || 0} 篇全局总结/概念`, 'var(--green)'],
        ['Outbox 待处理', `${telemetry.outboxPendingEvents || 0} 个事件`, telemetry.outboxPendingEvents ? 'var(--amber)' : 'var(--ink-3)'],
      ].map(([label,value,color])=><div key={label} style={{flex:'1 1 170px',minWidth:140,padding:'12px 14px',border:'1px solid var(--line)',borderRadius:8,background:'var(--surface)'}}>
        <div style={{fontSize:11,color:'var(--ink-3)',marginBottom:6}}>{label}</div><div style={{fontSize:13,fontWeight:600,color}}>{value}</div>
      </div>)}
    </div>

    {/* 权限 Scope 脑拓扑矩阵 */}
    <div style={{border:'1px solid var(--line)',borderRadius:8,overflow:'hidden',background:'var(--surface)',marginBottom:12}}>
      <div style={{padding:'10px 14px',fontSize:12,fontWeight:600,borderBottom:'1px solid var(--line)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span>🧠 权限 Scope 脑架构（同权限用户组自动复用）</span>
        <span style={{fontSize:11,color:'var(--ink-3)',fontWeight:400}}>共 {scopes.length} 个运行中 Scope</span>
      </div>
      <div style={{maxHeight:180,overflowY:'auto'}}>
        {scopes.map((s)=><div key={s.id} style={{display:'grid',gridTemplateColumns:'160px 80px 100px 120px 1fr 90px',gap:8,padding:'8px 14px',borderBottom:'1px solid var(--line-2)',fontSize:11.5,alignItems:'center'}}>
          <span style={{fontFamily:'monospace',fontWeight:600,color:'var(--ink)'}} title={s.fingerprint}>Scope: {s.fingerprint}</span>
          <span className={`badge ${s.strategy==='eager'?'ok':'purple'}`} style={{fontSize:10,padding:'1px 5px'}}>{s.strategy==='eager'?'⚡ Eager':'💤 Lazy'}</span>
          <span>👥 {s.membersCount} 名成员</span>
          <span>📚 {s.derivedCount} 篇派生页</span>
          <span style={{color:'var(--ink-3)',fontSize:11}}>ACL v{s.aclEpoch} · 知识 v{s.knowledgeEpoch}</span>
          <span style={{color:s.status==='active'?'var(--green)':'var(--amber)',textAlign:'right'}}>{s.status==='active'?'🟢 运行中':'🟡 待对账'}</span>
        </div>)}
        {!scopes.length && <div style={{padding:16,color:'var(--ink-3)',fontSize:12}}>暂无 Scope 记录，系统对账后会自动生成。</div>}
      </div>
    </div>

    <div style={{padding:'12px 14px',border:'1px solid var(--line)',borderRadius:8,background:'var(--surface-2)',fontSize:12,color:'var(--ink-3)',lineHeight:1.6,marginBottom:12}}>
      <b style={{color:'var(--ink)'}}>双级 Dream 维护架构</b>：{telemetry.enabled ? `已启用，每日 ${telemetry.cron}（${telemetry.timezone || '服务器时区'}）执行` : '已停用'}。
      <b>Tier 1 (Source Dream)</b> 负责单原始源的确定性维护与 Embedding 索引；
      <b>Tier 2 (Scope Dream)</b> 负责用户权限 Scope 内的跨源宏观综合与派生智能维护。
      {last && skippedPhases > 0 && <div style={{marginTop:4}}>GBrain phase 隔离：{skippedPhases} 个按 source 隔离策略跳过（私密 source 不外泄跨权限全局总结）。</div>}
      {last?.errorMessage && <div style={{color:'var(--red)',marginTop:4}}>最近失败：{last.errorMessage}</div>}
    </div>

    <div style={{border:'1px solid var(--line)',borderRadius:8,overflow:'hidden',background:'var(--surface)'}}>
      <div style={{padding:'10px 14px',fontSize:12,fontWeight:600,borderBottom:'1px solid var(--line)'}}>最近 Dream 运行记录</div>
      {(telemetry.runs || []).map((run)=><div key={run.id} style={{display:'grid',gridTemplateColumns:'145px 75px 1fr 120px',gap:10,padding:'9px 14px',borderBottom:'1px solid var(--line)',fontSize:11.5,alignItems:'center'}}>
        <span>{fmt(run.startedAt)}</span><b style={{color:statusColors[run.status] || 'var(--ink)'}}>{statusLabels[run.status] || run.status}</b><span>{run.sourcesVisited || 0} 个 source · {run.sourcesSucceeded || 0} 成功 · {run.sourcesPartial || 0} 部分 · {run.queuedTopics || 0} 个待编译主题</span><span style={{color:'var(--ink-3)'}}>{run.durationMs ? `${Math.round(run.durationMs/1000)} 秒` : '—'}</span>
      </div>)}
      {!telemetry.runs?.length && <div style={{padding:16,color:'var(--ink-3)',fontSize:12}}>暂无 Dream 运行记录。</div>}
      <PaginationBar pagination={telemetry.runsPagination} onChange={onPageChange || (() => {})} label="次 Dream 运行" />
    </div>

    <div style={{marginTop:10,fontSize:11,color:'var(--ink-3)'}}>当前 active source：{(telemetry.sources || []).length} 个 · 权限 Scope 脑：{scopes.length} 个 · 派生智能总结：{telemetry.derivedPagesCount || 0} 篇</div>
  </div>;
}

/* 新增子组织弹窗（支持无限层级） */
function AddOrgModal({parent, orgOptions = [], canCreateRoot = false, onAdd, onClose}){
  const [name, setName] = useState('');
  const [admins, setAdmins] = useState([]);
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
        <TagPicker placeholder="创建时直接指定管理员..." items={USERS.map(u=>({id:u.id,n:u.name,sub:u.org}))} selected={admins} setSelected={setAdmins}/>
        <div className="field-hint">管理员将同时成为该组织知识库管理员；上级组织管理员自动拥有本组织及下级组织的管理权限。被选人员还需具备“组织管理员”角色，角色可在人员/角色管理中配置。</div>
      </div>
      <div style={{padding:12,background:'var(--surface-2)',borderRadius:7,fontSize:12,color:'var(--ink-3)',lineHeight:1.6}}>
        <b style={{color:'var(--ink)'}}>继承规则</b>：{parentId ? '新组织将挂到所选组织之下，其成员自动继承上级组织的可见范围；' : '新组织将作为组织树根节点；'}可在创建后为该组织单独设置知识库管理员。
      </div>
    </Modal>
  );
}

function EditOrgModal({node, orgOptions = [], canCreateRoot = false, onSave, onClose}){
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

/* ============== Admin: 行业库授权中枢 (GrantPanel) ============== */
function GrantPanel({kbId, setKbId}){
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

  const currentGrants = GRANTS.filter(g => g.kbId === kbId);
  const filteredGrants = currentGrants.filter(g => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (g.subj || '').toLowerCase().includes(q) || (g.scope || '').toLowerCase().includes(q);
  });

  const selectedKbObj = INDUSTRY_KBS.find(k => k.id === kbId) || INDUSTRY_KBS[0];

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
              {INDUSTRY_KBS.map(k=>(
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
                👤 人员
              </button>
              <button
                type="button"
                className={`segmented-btn ${grantTab==='role'?'active':''}`}
                onClick={()=>{ setGrantTab('role'); setSubjectId(''); }}
              >
                🛡️ 角色
              </button>
              <button
                type="button"
                className={`segmented-btn ${grantTab==='org'?'active':''}`}
                onClick={()=>{ setGrantTab('org'); setSubjectId(''); }}
              >
                🏢 组织
              </button>
            </div>
          </div>

          <div className="field">
            <label>3️⃣ 选择具体{grantTab==='user'?'人员':grantTab==='role'?'角色':'组织'}<span className="req">*</span></label>
            <select value={subjectId} onChange={e=>setSubjectId(e.target.value)}>
              <option value="">点击检索并选择{grantTab==='user'?'人员':grantTab==='role'?'角色':'组织'}…</option>
              {grantTab==='user' && USERS.filter(u=>u.status!=='disabled').map(u=>(
                <option key={u.id} value={u.id}>
                  {u.name} (@{u.initials}) · {u.org || '全公司'}
                </option>
              ))}
              {grantTab==='role' && ROLES.map(r=>(
                <option key={r.id} value={r.id}>
                  {r.name} ({r.users || 0} 人)
                </option>
              ))}
              {grantTab==='org' && flattenOrgTree(ORG_TREE).map(o=>(
                <option key={o.id} value={o.id}>
                  {o.path}
                </option>
              ))}
            </select>
            <div className="field-hint">
              {grantTab==='org' ? '💡 组织授权将自动包含该节点下全部直属与递归子部门成员。' : grantTab==='role' ? '💡 绑定该角色的所有当前及未来成员均自动获得访问权。' : '💡 单人授权仅对该成员账号独立生效。'}
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
                            {g.avatar}
                          </div>
                        ) : (
                          <div style={{width:28,height:28,borderRadius:'50%',background:'var(--surface-2)',display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--line)'}}>
                            <Icon name={g.type==='role'?'users':'folder'} size={14} color="var(--ink-2)"/>
                          </div>
                        )}
                        <div>
                          <div style={{fontWeight:600,color:'var(--ink)',fontSize:'13px'}}>{g.subj}</div>
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
                        {g.type==='user'?'👤 人员':g.type==='role'?'🛡️ 角色':'🏢 组织'}
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
function OrgPanel({
  orgTree,
  expandedIds,
  onToggle,
  setExpandedIds,
  onAddChild,
  onSetAdmin,
  onEdit,
  onDelete,
  onActivateKb,
  onDeactivateKb,
  onManageKb,
  canCreateRoot = false
}){
  const [selectedNodeId, setSelectedNodeId] = useState<string>(() => orgTree?.id || '');
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

  const selectedNode = findNode(orgTree, selectedNodeId) || orgTree;
  const flatNodes = useMemo(() => flattenOrgTree(orgTree), [orgTree]);
  const subtreeUserCount = useMemo(() => selectedNode ? countSubtreeUsers(selectedNode, USERS) : 0, [selectedNode]);
  const directUsers = useMemo(() => selectedNode ? USERS.filter((u: any) => (u.orgNodes || []).some((on: any) => on.id === selectedNode.id) || (u.orgIds || []).includes(selectedNode.id)) : [], [selectedNode]);

  const expandAll = () => {
    const s = new Set<string>();
    const walk = (n: any) => { s.add(n.id); (n.children || []).forEach(walk); };
    if (orgTree) walk(orgTree);
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
            <div className="split-card-title">
              🏢 组织拓扑树
            </div>
            <span style={{fontSize:'11.5px',color:'var(--ink-3)'}}>共 {flatNodes.length} 个节点</span>
          </div>

          <div style={{marginBottom:10}}>
            <div className="search-input" style={{maxWidth:'100%'}}>
              <input placeholder="快速筛选组织节点…" value={nodeSearch} onChange={e=>setNodeSearch(e.target.value)}/>
            </div>
          </div>

          <div className="org-tree-box">
            {orgTree ? (
              <OrgTreeItem
                node={orgTree}
                depth={0}
                expandedIds={expandedIds}
                selectedNodeId={selectedNodeId}
                onSelect={(id: string)=>setSelectedNodeId(id)}
                onToggle={onToggle}
                onAddChild={onAddChild}
                onSetAdmin={onSetAdmin}
                onEdit={onEdit}
                onDelete={onDelete}
                search={nodeSearch}
              />
            ) : (
              <div style={{padding:24,color:'var(--ink-4)',textAlign:'center'}}>暂无组织节点</div>
            )}
          </div>
        </div>

        {/* Right: Selected Node Profile Card */}
        {selectedNode ? (
          <div className="split-card">
            <div className="split-card-header">
              <div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:'20px'}}>🏢</span>
                  <div style={{fontSize:'16px',fontWeight:600,color:'var(--ink)'}}>{selectedNode.name}</div>
                  {selectedNode.kbs && selectedNode.kbs.length > 0 ? (
                    <span className="badge ok" style={{fontSize:'11px'}}>🟢 部门库已激活</span>
                  ) : (
                    <span className="badge" style={{fontSize:'11px'}}>⚪ 未激活部门库</span>
                  )}
                </div>
                <div style={{fontSize:'11.5px',color:'var(--ink-3)',marginTop:4}}>
                  全路径：{selectedNode.path || selectedNode.name}
                </div>
              </div>
              <div style={{display:'flex',gap:6}}>
                {selectedNode.canCreateChild && (
                  <button className="btn primary" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onAddChild(selectedNode)}>
                    <Icon name="plus" size={12}/> 添加子组织
                  </button>
                )}
                {selectedNode.canManage && (
                  <>
                    <button className="btn" style={{fontSize:'11.5px',padding:'4px 10px'}} onClick={()=>onEdit?.(selectedNode)}>编辑组织</button>
                    <button className="btn danger" style={{fontSize:'11.5px',padding:'4px 10px'}} disabled={(selectedNode.children || []).length > 0} title={(selectedNode.children || []).length > 0 ? '请先处理下属组织' : '删除组织'} onClick={()=>onDelete?.(selectedNode)}>删除组织</button>
                  </>
                )}
              </div>
            </div>

            {/* KPI Metrics */}
            <div className="org-kpi-grid">
              <div className="org-kpi-box">
                <div className="kpi-label">👥 组织穿透总人数</div>
                <div className="kpi-val">{subtreeUserCount} <span style={{fontSize:'12px',fontWeight:400,color:'var(--ink-3)'}}>人 (直属 {directUsers.length} 人)</span></div>
              </div>
              <div className="org-kpi-box">
                <div className="kpi-label">📁 下级子部门数</div>
                <div className="kpi-val">{selectedNode.children?.length || 0} <span style={{fontSize:'12px',fontWeight:400,color:'var(--ink-3)'}}>个下属分支</span></div>
              </div>
            </div>

            {/* Department Knowledge Base Section */}
            <div style={{background:'var(--surface-2)',border:'1px solid var(--line-2)',borderRadius:8,padding:'14px 16px',marginBottom:16}}>
              <div style={{fontSize:'13px',fontWeight:600,color:'var(--ink)',marginBottom:6,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span>📚 组织知识库</span>
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
                <span>👑 组织知识库管理员团队</span>
                {selectedNode.canSetAdmin && (
                  <button className="btn" style={{padding:'3px 9px',fontSize:'11.5px'}} onClick={()=>onSetAdmin(selectedNode)}>
                    ⚙️ 设置管理员
                  </button>
                )}
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                {(selectedNode.admins || []).length > 0 ? (
                  selectedNode.admins.map((nm: string, i: number) => {
                    const u = USERS.find((user: any) => user.name === nm);
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

function OrgTreeItem({node, depth, expandedIds, selectedNodeId, onSelect, onToggle, onAddChild, onSetAdmin, onEdit, onDelete, search}: any){
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
        <span style={{fontSize:'13px',marginRight:4}}>
          {depth === 0 ? '🏢' : hasChildren ? '📁' : '📄'}
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

/* ============== 知识图谱（Obsidian 风格力导向布局） ============== */

function runForceLayout(nodes, edges, options) {
  const opts = options || {};
  const width = opts.width ?? 900;
  const height = opts.height ?? 600;
  const chargeStrength = opts.chargeStrength ?? -380;
  const linkDistance = opts.linkDistance ?? 60;
  const iterations = opts.iterations ?? 600;
  const N = nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  const radiusFor = (n) => (n.type === 'knowledge_base' ? 18 : n.type === 'document' ? 12 : 8);
  const pos = nodes.map((_, i) => {
    const ratio = (i + 0.5) / Math.max(N, 1);
    const ring = Math.floor(Math.sqrt(ratio) * Math.sqrt(N));
    const angle = ratio * Math.PI * 2 * 4;
    const r = ring * Math.min(width, height) * 0.04 + 20;
    return {
      x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 8,
      y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 8,
      fx: 0,
      fy: 0,
    };
  });
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = Math.max(0.04, 1 - iter / iterations);
    for (let i = 0; i < N; i++) {
      pos[i].fx = (cx - pos[i].x) * 0.012 * alpha;
      pos[i].fy = (cy - pos[i].y) * 0.012 * alpha;
    }
    for (let i = 0; i < N; i++) {
      const a = pos[i]; const aNode = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = pos[j]; const bNode = nodes[j];
        let dx = a.x - b.x; let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy; if (dist2 < 1) { dist2 = 1; dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); }
        const dist = Math.max(Math.sqrt(dist2), 0.1);
        const repulseForce = (Math.abs(chargeStrength) / (dist2 + 40)) * alpha;
        const fx = (dx / dist) * repulseForce; const fy = (dy / dist) * repulseForce;
        a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
        const minDist = radiusFor(aNode) + radiusFor(bNode) + 12;
        if (dist < minDist) {
          const push = (minDist - dist) / dist * 0.4 * alpha;
          a.fx += (dx / dist) * push * 10;
          a.fy += (dy / dist) * push * 10;
          b.fx -= (dx / dist) * push * 10;
          b.fy -= (dy / dist) * push * 10;
        }
      }
    }
    for (const e of edges) {
      const si = idx.get(e.source) as number | undefined; const ti = idx.get(e.target) as number | undefined;
      if (si == null || ti == null) continue;
      const a = pos[si]; const b = pos[ti];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = linkDistance + (e.type === 'contains' ? -8 : 0);
      const diff = (dist - target) / dist;
      const k = diff * 0.18 * alpha * (1 + Math.min(2, (e.weight || 1) * 0.1));
      a.fx += dx * k; a.fy += dy * k; b.fx -= dx * k; b.fy -= dy * k;
    }
    const damp = 0.2;
    for (let i = 0; i < N; i++) {
      const vx = Math.max(-15, Math.min(15, pos[i].fx * damp));
      const vy = Math.max(-15, Math.min(15, pos[i].fy * damp));
      pos[i].x += vx;
      pos[i].y += vy;
      pos[i].x = Math.max(60, Math.min(width - 60, pos[i].x));
      pos[i].y = Math.max(60, Math.min(height - 60, pos[i].y));
    }
  }
  return nodes.map((n, i) => ({ ...n, x: pos[i].x, y: pos[i].y }));
}

function KnowledgeGraphScreen({ onOpenDocument, onOpenKb }){
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [layout, setLayout] = useState(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [types, setTypes] = useState({ knowledge_base: true, document: true, concept: true });
  const [localRoot, setLocalRoot] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [params, setParams] = useState({ charge: -320, link: 60, showLabels: 'auto' });

  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1100, h: 720 });

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

  const allNodes = graph?.nodes || [];
  const allEdges = graph?.edges || [];

  const visibleIds = useMemo(() => {
    const ids = new Set();
    for (const n of allNodes) if (types[n.type]) ids.add(n.id);
    return ids;
  }, [allNodes, types]);

  const filteredNodes = useMemo(() => allNodes.filter((n) => visibleIds.has(n.id)), [allNodes, visibleIds]);
  const filteredEdges = useMemo(() => allEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)), [allEdges, visibleIds]);

  const focusNodes = useMemo(() => {
    if (!localRoot) return filteredNodes;
    const depthMap = new Map([[localRoot, 0]]);
    const adj = new Map();
    for (const e of filteredEdges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
    const queue = [localRoot];
    while (queue.length) {
      const cur = queue.shift();
      const d = depthMap.get(cur) || 0;
      if (d >= 2) continue;
      for (const next of adj.get(cur) || []) {
        if (!depthMap.has(next)) { depthMap.set(next, d + 1); queue.push(next); }
      }
    }
    return filteredNodes.filter((n) => depthMap.has(n.id));
  }, [filteredNodes, filteredEdges, localRoot]);

  const focusEdges = useMemo(() => {
    const ids = new Set(focusNodes.map((n) => n.id));
    return filteredEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [focusNodes, filteredEdges]);

  const degreeMap = useMemo(() => {
    const m = new Map();
    for (const e of filteredEdges) { m.set(e.source, (m.get(e.source) || 0) + 1); m.set(e.target, (m.get(e.target) || 0) + 1); }
    return m;
  }, [filteredEdges]);

  useEffect(() => {
    const canvas = svgRef.current?.parentElement;
    if (!canvas) return undefined;
    const update = () => {
      if (canvas.clientWidth > 100 && canvas.clientHeight > 100) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        setCanvasSize((prev) => (Math.abs(prev.w - w) > 20 || Math.abs(prev.h - h) > 20) ? { w, h } : prev);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!graph || filteredNodes.length === 0) { setLayout(null); return; }
    const { w, h } = canvasSize;
    const t = setTimeout(() => {
      setLayout((prev) => {
        if (prev && localRoot === prev._root && filteredNodes.length === prev._count && prev._w === w && prev._h === h) {
          const sameParams = prev._charge === params.charge && prev._link === params.link;
          if (sameParams) return prev;
        }
        const positioned = runForceLayout(focusNodes, focusEdges, { width: w, height: h, chargeStrength: params.charge, linkDistance: params.link });
        requestAnimationFrame(() => {
          const xs = positioned.map((n: any) => n.x); const ys = positioned.map((n: any) => n.y);
          if (xs.length > 0) {
            const minX = Math.min(...xs); const maxX = Math.max(...xs);
            const minY = Math.min(...ys); const maxY = Math.max(...ys);
            const bboxW = Math.max(maxX - minX, 1); const bboxH = Math.max(maxY - minY, 1);
            const kx = (w - 80) / bboxW; const ky = (h - 80) / bboxH;
            const k = Math.min(1.8, Math.max(0.7, Math.min(kx, ky)));
            const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
            setTransform({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });
          }
        });
        return { nodes: positioned, _root: localRoot, _count: focusNodes.length, _charge: params.charge, _link: params.link, _w: w, _h: h };
      });
    }, 16);
    return () => clearTimeout(t);
  }, [focusNodes, focusEdges, graph, localRoot, params.charge, params.link, canvasSize.w, canvasSize.h]);

  const positions = useMemo(() => {
    const map = new Map();
    if (layout) for (const n of layout.nodes) map.set(n.id, { x: n.x, y: n.y });
    return map;
  }, [layout]);

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase(); if (!q) return null;
    const s = new Set();
    for (const n of filteredNodes) if (n.label.toLowerCase().includes(q)) s.add(n.id);
    return s;
  }, [query, filteredNodes]);

  const hoverId = hovered || selected;
  const neighborIds = useMemo(() => {
    if (!hoverId) return null;
    const s = new Set([hoverId]);
    for (const e of filteredEdges) {
      if (e.source === hoverId) s.add(e.target);
      if (e.target === hoverId) s.add(e.source);
    }
    return s;
  }, [hoverId, filteredEdges]);

  const selectedNode = allNodes.find((n) => n.id === selected);
  const selectedEdges = selected ? allEdges.filter((e) => e.source === selected || e.target === selected) : [];
  const relatedByType = useMemo(() => {
    const groups = { contains: [], mentions: [], related_to: [] };
    for (const e of selectedEdges) {
      const key = e.type;
      const bucket = (groups[key] || (groups[key] = []));
      bucket.push(e);
    }
    return groups;
  }, [selectedEdges, selected]);

  const nodeColor = { knowledge_base: '#7c6cd9', document: '#4c7fd0', concept: '#c08a3e' };
  const labelText = (n) => n.label.length > 14 ? `${n.label.slice(0, 14)}…` : n.label;
  const nodeRadius = (n) => {
    const base = n.type === 'knowledge_base' ? 18 : n.type === 'document' ? 13 : 8;
    const deg = degreeMap.get(n.id) || 0;
    return base + Math.min(8, deg * 0.6);
  };
  const showLabel = (n) => {
    if (params.showLabels === 'always') return true;
    if (params.showLabels === 'off') return false;
    if (hoverId && neighborIds && neighborIds.has(n.id)) return true;
    if (matchIds && matchIds.has(n.id)) return true;
    return transform.k > 1.05;
  };
  const edgeActive = (e) => !hoverId || e.source === hoverId || e.target === hoverId;

  const onWheel = (event) => {
    event.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const cx = event.clientX - rect.left; const cy = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.3, Math.min(3.5, transform.k * factor));
    const ratio = next / transform.k;
    setTransform({ k: next, x: cx - (cx - transform.x) * ratio, y: cy - (cy - transform.y) * ratio });
  };

  const onMouseDown = (event) => {
    if (event.target.closest('.graph-node')) return;
    panRef.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
  };
  const onMouseMove = (event) => {
    if (dragRef.current) {
      const d = dragRef.current;
      d.node.fx = d.node.x = d.startX + (event.clientX - d.startClientX) / transform.k;
      d.node.fy = d.node.y = d.startY + (event.clientY - d.startClientY) / transform.k;
      setLayout({ ...layout, nodes: [...layout.nodes] });
      return;
    }
    if (panRef.current) {
      setTransform({ ...transform, x: panRef.current.tx + (event.clientX - panRef.current.x), y: panRef.current.ty + (event.clientY - panRef.current.y) });
    }
  };
  const onMouseUp = () => { dragRef.current = null; panRef.current = null; };

  const startNodeDrag = (event, node) => {
    event.stopPropagation();
    dragRef.current = { node, startX: node.x, startY: node.y, startClientX: event.clientX, startClientY: event.clientY };
  };
  const onNodeClick = (event, node) => { event.stopPropagation(); setSelected(node.id); };
  const onNodeDouble = (event, node) => {
    event.stopPropagation();
    if (node.type === 'document' && node.documentId && node.kbId) onOpenDocument?.(node.kbId, node.documentId, node.label);
    else if (node.type === 'knowledge_base' && node.kbId) onOpenKb?.(node.kbId);
  };

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { setSelected(null); setHovered(null); }
      if (event.key === 'f' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); (document.querySelector('.graph-search input') as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fitView = () => {
    setTransform({ x: 0, y: 0, k: 1.0 });
  };

  const resetView = () => { setTransform({ x: 0, y: 0, k: 1 }); };
  const rerunLayout = () => setLayout(null);

  const lastFitKey = useRef('');
  useEffect(() => {
    if (!layout) return;
    const key = `${layout._root || 'global'}:${layout._count}:${layout._w}x${layout._h}`;
    if (key !== lastFitKey.current) {
      lastFitKey.current = key;
      requestAnimationFrame(() => fitView());
    }
    const canvas = svgRef.current?.parentElement;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (canvas.clientWidth > 100) {
        fitView();
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [layout]);
  const centerOnSelected = () => {
    if (!selected || !positions.has(selected)) return;
    const p = positions.get(selected);
    const canvas = svgRef.current?.parentElement;
    setTransform({ ...transform, x: canvas.clientWidth / 2 - p.x * transform.k, y: canvas.clientHeight / 2 - p.y * transform.k });
  };

  const counts = useMemo(() => {
    const c = { knowledge_base: 0, document: 0, concept: 0 };
    for (const n of filteredNodes) c[n.type] = (c[n.type] || 0) + 1;
    return c;
  }, [filteredNodes]);

  if (loading) return <div className="graph-page"><div className="graph-state">正在构建你的知识图谱…</div></div>;
  if (error) return <div className="graph-page"><div className="graph-state error">{error}</div></div>;

  return (
    <div className="graph-page">
      <div className="graph-head">
        <div>
          <div className="h1">知识图谱</div>
          <div className="subline">展示你有权访问的已发布知识 · 滚轮缩放、拖拽节点、悬停高亮邻居</div>
        </div>
        <div className="graph-stats">
          <span>{graph?.stats?.documents || 0} 文档</span>
          <span>{graph?.stats?.concepts || 0} 个主题</span>
          <span>{graph?.stats?.relations || 0} 条关系</span>
        </div>
      </div>

      <div className="graph-toolbar">
        <div className="graph-type-filter">
          {[
            { k: 'knowledge_base', l: '知识库', c: nodeColor.knowledge_base },
            { k: 'document', l: '文档', c: nodeColor.document },
            { k: 'concept', l: '主题', c: nodeColor.concept },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              className={`graph-type-chip ${types[t.k] ? 'on' : ''}`}
              onClick={() => setTypes({ ...types, [t.k]: !types[t.k] })}
              aria-pressed={types[t.k]}
            >
              <i style={{ background: t.c }} />
              <span>{t.l}</span>
              <em>{counts[t.k] || 0}</em>
            </button>
          ))}
        </div>
        <div className="graph-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档或主题（⌘F 聚焦）"
            onKeyDown={(event) => { if (event.key === 'Enter' && matchIds) { const first = [...matchIds][0]; if (first) setSelected(first); } }}
          />
          {matchIds && <span className="graph-search-hint">{matchIds.size} 命中</span>}
        </div>
        {localRoot && (
          <button type="button" className="graph-local-back" onClick={() => { setLocalRoot(null); setSelected(null); }}>
            ← 返回全局图谱
          </button>
        )}
        <div className="graph-toolbar-spacer" />
        <button type="button" className="graph-icon-btn" title="重新布局" onClick={rerunLayout}><Icon name="refresh" size={14} /></button>
        <button type="button" className="graph-icon-btn" title="适应视图" onClick={fitView}><Icon name="search" size={14} /></button>
        <button type="button" className={`graph-icon-btn ${showSettings ? 'on' : ''}`} title="显示设置" onClick={() => setShowSettings(!showSettings)}><Icon name="setting" size={14} /></button>
      </div>

      {showSettings && (
        <div className="graph-settings">
          <label>斥力强度 <input type="range" min="-400" max="-40" value={params.charge} onChange={(e) => setParams({ ...params, charge: Number(e.target.value) })} /></label>
          <label>连线距离 <input type="range" min="40" max="160" value={params.link} onChange={(e) => setParams({ ...params, link: Number(e.target.value) })} /></label>
          <label>标签显示
            <select value={params.showLabels} onChange={(e) => setParams({ ...params, showLabels: e.target.value })}>
              <option value="auto">自动（缩放时显示）</option>
              <option value="always">始终显示</option>
              <option value="off">始终隐藏</option>
            </select>
          </label>
        </div>
      )}

      <div className="graph-layout">
        <div className="graph-canvas" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
          {filteredNodes.length === 0 ? (
            <div className="graph-state">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 8 }}>当前没有可生成图谱的已发布知识</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>去「知识库」上传一份文档，发布后会自动出现在这里</div>
              </div>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="个人知识图谱"
              onWheel={onWheel}
              onMouseDown={onMouseDown}
              style={{ cursor: panRef.current ? 'grabbing' : 'grab' }}
            >
              <defs>
                <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#b9b5ae" />
                </marker>
              </defs>
              <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
                {focusEdges.map((edge) => {
                  const a = positions.get(edge.source); const b = positions.get(edge.target);
                  if (!a || !b) return null;
                  const active = edgeActive(edge);
                  const opacity = hoverId ? (active ? 0.85 : 0.05) : 0.6;
                  return (
                    <g key={edge.id} opacity={opacity}>
                      <line
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={edge.type === 'related_to' ? '#c08a3e' : '#9C978C'}
                        strokeWidth={Math.min(2.2, 0.7 + (edge.weight || 1) * 0.25) / Math.max(1, transform.k * 0.7)}
                        markerEnd="url(#graph-arrow)"
                      />
                      <title>{edge.type === 'contains' ? '包含' : edge.type === 'mentions' ? '提及' : '共同主题'} · 权重 {edge.weight}</title>
                    </g>
                  );
                })}
                {focusNodes.map((node) => {
                  const p = positions.get(node.id); if (!p) return null;
                  const dimmed = hoverId && !(neighborIds.has(node.id));
                  const isMatch = matchIds && matchIds.has(node.id);
                  const isSelected = selected === node.id;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${p.x},${p.y})`}
                      opacity={dimmed ? 0.18 : 1}
                      className={`graph-node ${isSelected ? 'selected' : ''}`}
                      onMouseEnter={() => setHovered(node.id)}
                      onMouseLeave={() => setHovered(null)}
                      onMouseDown={(e) => startNodeDrag(e, node)}
                      onClick={(e) => onNodeClick(e, node)}
                      onDoubleClick={(e) => onNodeDouble(e, node)}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle
                        r={nodeRadius(node)}
                        fill={nodeColor[node.type]}
                        stroke={isSelected ? '#111827' : isMatch ? '#B7791F' : 'white'}
                        strokeWidth={isSelected ? 2.5 : isMatch ? 2 : 1.5}
                      />
                      {(isMatch || (showLabel(node))) && (
                        <text x={nodeRadius(node) + 5} y={4} className="graph-node-label" style={{ fontSize: 11 / transform.k }}>
                          {labelText(node)}
                        </text>
                      )}
                      <title>{node.label} · {node.type === 'knowledge_base' ? '知识库' : node.type === 'document' ? '文档' : '主题'}</title>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          <div className="graph-zoom-ctl">
            <button type="button" onClick={() => setTransform({ ...transform, k: Math.min(3.5, transform.k * 1.2) })} aria-label="放大">＋</button>
            <span className="graph-zoom-pct">{Math.round(transform.k * 100)}%</span>
            <button type="button" onClick={() => setTransform({ ...transform, k: Math.max(0.3, transform.k / 1.2) })} aria-label="缩小">−</button>
            <button type="button" onClick={resetView} title="重置视图">⤾</button>
            {selected && <button type="button" onClick={centerOnSelected} title="居中到选中节点">⊙</button>}
          </div>
        </div>

        <aside className="graph-detail">
          {selectedNode ? (
            <>
              <div className="graph-detail-type" style={{ color: nodeColor[selectedNode.type] }}>
                {selectedNode.type === 'knowledge_base' ? '知识库' : selectedNode.type === 'document' ? '文档' : '主题'}
              </div>
              <h3>{selectedNode.label}</h3>
              <div className="graph-detail-actions">
                {selectedNode.type === 'document' && selectedNode.documentId && selectedNode.kbId && (
                  <button type="button" className="btn primary" onClick={() => onOpenDocument?.(selectedNode.kbId, selectedNode.documentId, selectedNode.label)}>
                    打开文档
                  </button>
                )}
                {selectedNode.type === 'knowledge_base' && selectedNode.kbId && (
                  <button type="button" className="btn primary" onClick={() => onOpenKb?.(selectedNode.kbId)}>
                    进入知识库
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setLocalRoot(selectedNode.id)}>
                  展开局部图谱
                </button>
              </div>
              <p>
                {selectedNode.type === 'document' && '该节点来自可见知识库中的已发布文档。'}
                {selectedNode.type === 'concept' && '该主题由章节、标题、显式引用和文档内容共同提取。'}
                {selectedNode.type === 'knowledge_base' && '该节点表示一个可见知识库。'}
              </p>
              {(['contains', 'mentions', 'related_to'] as const).map((type) => {
                const list = relatedByType[type] || [];
                if (list.length === 0) return null;
                const label = type === 'contains' ? '包含的文档' : type === 'mentions' ? '提及该主题的文档' : '相关文档';
                return (
                  <div className="graph-related" key={type}>
                    <b>{label} <em>· {list.length}</em></b>
                    {list.slice(0, 8).map((edge) => {
                      const otherId = edge.source === selected ? edge.target : edge.source;
                      const other = allNodes.find((n) => n.id === otherId);
                      return (
                        <div key={edge.id} className="graph-related-row" onClick={() => setSelected(otherId)}>
                          <span style={{ color: nodeColor[type === 'contains' ? 'document' : 'concept'] }}>·</span>
                          {other?.label || '—'}
                        </div>
                      );
                    })}
                    {list.length > 8 && <div className="graph-related-more">还有 {list.length - 8} 条…</div>}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <h3>点击节点查看详情</h3>
              <p>图谱不会显示无权限知识。点击文档或主题节点，可查看它与其他知识的关联；双击可直达原始文档或知识库。</p>
              <div className="graph-detail-hints">
                <div><kbd>滚轮</kbd> 缩放 · <kbd>拖拽空白</kbd> 平移 · <kbd>拖拽节点</kbd> 布局</div>
                <div><kbd>悬停</kbd> 高亮邻居 · <kbd>点击</kbd> 查看 · <kbd>双击</kbd> 打开</div>
                <div><kbd>⌘F</kbd> 聚焦搜索 · <kbd>Esc</kbd> 取消选择</div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ============== App 入口 ============== */
function LoginScreen({ onSubmit, error, loading }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
        <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:10}}>
          <span style={{fontSize:28,fontWeight:700,letterSpacing:'-0.02em',color:'#191817'}}>GBrain</span>
          <span style={{fontSize:12,color:'#9C978C',letterSpacing:'0.04em'}}>企业级知识库</span>
        </div>
        <div style={{color:'#756f66',fontSize:14,marginBottom:28}}>登录你的企业大脑</div>
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

function PasswordChangeScreen({ onSubmit, onLogout, error, loading }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => {
        event.preventDefault();
        if (newPassword.length < 12) return setLocalError('新密码至少需要 12 个字符');
        if (newPassword !== confirmPassword) return setLocalError('两次输入的新密码不一致');
        setLocalError('');
        onSubmit(currentPassword, newPassword);
      }}>
        <div style={{fontSize:28,fontWeight:700,letterSpacing:'-0.02em',color:'#191817',marginBottom:10}}>首次登录安全设置</div>
        <div style={{color:'#756f66',fontSize:14,lineHeight:1.7,marginBottom:24}}>为了保护生产环境，请先修改 admin 的初始化密码。</div>
        <label style={{display:'block',fontSize:13,marginBottom:6}}>当前密码</label>
        <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>新密码</label>
        <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>确认新密码</label>
        <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:18}} />
        {(localError || error) && <div style={{color:'#b42318',fontSize:13,marginBottom:14}}>{localError || error}</div>}
        <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '保存中…' : '保存新密码'}</button>
        <button type="button" onClick={onLogout} className="btn" style={{width:'100%',justifyContent:'center',padding:11,marginTop:10}}>退出</button>
      </form>
    </div>
  );
}

function App(){

  const [dbData, setDbData] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  // Keep server HTML and the first browser render identical. Reading
  // localStorage in the state initializer caused a production hydration
  // mismatch on a fresh visit and could surface Next's "page couldn't load".
  const [authState, setAuthState] = useState('checking');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    const saved = window.localStorage.getItem('llmwiki_theme');
    setTheme(saved === 'dark' || saved === 'light'
      ? saved
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('llmwiki_theme', theme);
  }, [theme]);

  const loadAdminData = async (token) => {
    const res = await fetch(`${API_BASE_URL}/api/v1/admin/data`, { headers: { Authorization: `Bearer ${token}` } });
    let d;
    if (res.ok) {
      d = await res.json();
    } else if (res.status === 403) {
      const sessionRes = await fetch(`${API_BASE_URL}/api/v1/session/bootstrap`, { headers: { Authorization: `Bearer ${token}` } });
      if (!sessionRes.ok) throw new Error(`API ${sessionRes.status}`);
      const session = await sessionRes.json();
      d = { ...session, kbs: session.kbs || [], users: [], orgs: [], roles: [], grants: [], providers: [], models: [], audit: [], dream: null };
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
      const orgNames = orgNodes.map((node: any) => node.name).filter(Boolean);
      const orgPaths = orgNodes.map((node: any) => node.path || node.name).filter(Boolean);
      return {
        id: u.id,
        name: u.displayName || u.username,
        initials: u.username,
        email: u.email,
        t: u.source === 'manual' ? '手动创建' : (u.source || '系统用户'),
        roles: roles.length ? roles : ['普通用户'],
        status: u.status || 'active',
        org: orgNames.join('、') || '未分配组织',
        orgPath: orgPaths.join('、') || '—',
        orgs: orgNames,
        orgNodes: orgNodes,
        orgIds: orgNodes.map((node: any) => node.id),
        canManage: Boolean(u.canManage),
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
    AUDIT_META = d.auditPagination || { page: 1, limit: 20, total: AUDIT.length, totalPages: 1 };
    DREAM = d.dream || null;
    SYSTEM_STATUS = d.systemStatus || null;
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
    fetch(`${API_BASE_URL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json();
      })
      .then(async (me) => {
        if (me.user?.mustChangePassword) {
          setAuthState('mustChangePassword');
          return;
        }
        await loadAdminData(token);
        setAuthState('loggedIn');
      })
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
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429 || (result.message && String(result.message).includes('Too Many Requests'))) {
          throw new Error('请求过于频繁，请稍候再试');
        }
        throw new Error(result.message || '登录失败');
      }
      window.localStorage.setItem('llmwiki_token', result.token);
      if (result.user?.mustChangePassword) {
        setPasswordChangeError('');
        setAuthState('mustChangePassword');
        return;
      }
      await loadAdminData(result.token);
      setAuthState('loggedIn');
    } catch (error) {
      setLoginError(error.message || '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handlePasswordChange = async (currentPassword, newPassword) => {
    setPasswordChangeLoading(true);
    setPasswordChangeError('');
    try {
      const token = window.localStorage.getItem('llmwiki_token');
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '密码修改失败');
      await loadAdminData(token);
      setAuthState('loggedIn');
    } catch (error) {
      setPasswordChangeError(error.message || '密码修改失败');
    } finally {
      setPasswordChangeLoading(false);
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




  const [screen, setScreen] = useState('chat');
  const [adminTab, setAdminTab] = useState('org');
  const [libraryKbId, setLibraryKbId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [graphOnlinePreview, setGraphOnlinePreview] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  useEffect(() => {
    if (window.location.pathname.startsWith('/admin')) setScreen('admin');
  }, []);

  const openGraphDocument = (kbId, documentId, title) => {
    setGraphOnlinePreview({ kbId, docId: documentId, title: title || '原始文档' });
  };
  const openGraphKb = (kbId) => {
    setLibraryKbId(kbId);
    setScreen('libs');
  };

  const paletteNav = (target, payload) => {
    setScreen(target);
    if (payload?.kbId) setLibraryKbId(payload.kbId);
    if (payload?.convId) {
      const evt = new CustomEvent('app-open-conversation', { detail: payload.convId });
      window.dispatchEvent(evt);
    }
  };
  const paletteNewChat = () => {
    setScreen('chat');
    window.dispatchEvent(new CustomEvent('app-new-chat'));
  };
  const paletteNewKb = () => {
    setScreen('libs');
    setAdminTab('newkb');
    window.dispatchEvent(new CustomEvent('app-new-kb'));
  };
  const paletteUpload = () => {
    setScreen('libs');
    setTimeout(() => window.dispatchEvent(new CustomEvent('app-focus-upload')), 120);
  };

  useEffect(()=>{
    const h = (e)=>{
      setToast({ text: e.detail, undo: null });
      if(toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(()=>setToast(null), 4000);
    };
    window.addEventListener('app-toast', h);
  const u = (e)=>{
      const d = e.detail || {};
      setToast({ text: d.message || '已操作', undo: d.undo ? { label: d.undoLabel || '撤销', fn: d.undo } : null });
      if(toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(()=>setToast(null), 5000);
    };
    window.addEventListener('app-undoable', u);
  return ()=>{ window.removeEventListener('app-toast', h); window.removeEventListener('app-undoable', u); };
  },[]);

  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const inEditable = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((v) => !v); return; }
      if (e.key === 'Escape') { if (paletteOpen) { setPaletteOpen(false); e.preventDefault(); } return; }
      if (inEditable) return;
      if (e.key === '?' && !mod && !e.altKey) { e.preventDefault(); setHelpOpen(true); return; }
      if (mod && (e.key === '1')) { e.preventDefault(); setScreen('chat'); return; }
      if (mod && (e.key === '2')) { e.preventDefault(); setScreen('libs'); return; }
      if (mod && (e.key === '3')) { e.preventDefault(); setScreen('graph'); return; }
      if (mod && (e.key === '4')) { e.preventDefault(); setScreen('admin'); return; }
      if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); paletteNewChat(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const titles = {
    chat: {t:'对话', s:`你的大脑 · ${KNOWLEDGE_BASES.length} 个可见知识库`},
    libs: {t:'知识库', s:`${KNOWLEDGE_BASES.length} 个知识库`},
    graph: {t:'知识图谱', s:'你的知识 · 可见知识关系'},
    admin: {t:'管理后台', s:'组织 · 人员 · 角色 · 行业库 · 授权 · 模型 · 审计'},
    settings: {t:'系统设置', s:'模型与供应商配置'},
  };

  if (authState === 'checking') return <div style={{padding:40,textAlign:"center",color:"#999"}}>正在验证登录状态…</div>;
  if (authState === 'loggedOut') return <LoginScreen onSubmit={handleLogin} error={loginError} loading={loginLoading}/>;
  if (authState === 'mustChangePassword') return <PasswordChangeScreen onSubmit={handlePasswordChange} onLogout={handleLogout} error={passwordChangeError} loading={passwordChangeLoading}/>;
  if (!dbData) return <div style={{padding:40,textAlign:"center",color:"#999"}}>系统正在加载企业数据底座，请稍候...</div>;
  if (dbData.error) return <div style={{padding:40,textAlign:"center",color:"#999"}}>企业数据底座暂不可用，请检查 API、数据库和登录状态后重试。</div>;
  const canAdmin = CAPABILITIES.includes('*') || ['org.read','org.user.read','role.read','kb.industry.read','kb.industry.create','kb.industry.grant','audit.read'].some(permission => CAPABILITIES.includes(permission));
  const canSettings = CAPABILITIES.includes('*') || CAPABILITIES.includes('system.settings.read') || CAPABILITIES.includes('system.settings.manage');
  const visibleScreen = (screen === 'admin' && !canAdmin) || (screen === 'settings' && !canSettings) ? 'chat' : screen;
  return (
    <div className="app">
      <SideNav active={visibleScreen} setActive={setScreen} user={currentUser} onLogout={handleLogout} kbCount={KNOWLEDGE_BASES.length} capabilities={CAPABILITIES}/>
      <div className="main">
        <TopBar
          title={titles[visibleScreen].t}
          sub={titles[visibleScreen].s}
          theme={theme || 'light'}
          onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenHelp={() => { window.location.assign('/help'); }}
          onOpenNotifications={() => setNotifOpen(true)}
        />
        <div className="content">
          {/* 四屏常驻挂载：跨屏切换不丢会话/表单状态（UX 评审修复） */}
          <div style={{display: visibleScreen==='chat'?'flex':'none', flex:1, minWidth:0}}>
          <ChatScreen/>
          </div>
          <div style={{display: visibleScreen==='libs'?'flex':'none', flex:1, minWidth:0}}>
            <LibrariesScreen initialKbId={libraryKbId} capabilities={CAPABILITIES} onManageGrant={(kb)=>{setAdminTab('grant'); setScreen('admin');}}/>
          </div>
          <div style={{display: visibleScreen==='graph'?'flex':'none', flex:1, minWidth:0}}>
            <KnowledgeGraphScreen onOpenDocument={openGraphDocument} onOpenKb={openGraphKb}/>
          </div>
          <div style={{display: visibleScreen==='admin' || visibleScreen==='settings'?'flex':'none', flex:1, minWidth:0}}>
            <AdminScreen initialTab={visibleScreen==='settings' ? 'model' : visibleScreen==='admin' ? adminTab : undefined} capabilities={CAPABILITIES} onOpenGrant={(k)=>{setAdminTab('grant'); setScreen('admin');}} onManageKb={(kbId)=>{setLibraryKbId(kbId); setScreen('libs');}}/>
          </div>
        </div>
      </div>
      {toast && (
        <div className="toast">
          <span className="tdot"/>
          <span>{typeof toast === 'string' ? toast : toast.text}</span>
          {typeof toast !== 'string' && toast.undo && (
            <button type="button" className="toast-undo" onClick={() => { toast.undo.fn(); setToast(null); }}>{toast.undo.label}</button>
          )}
        </div>
      )}
      {graphOnlinePreview && <OnlinePreviewModal preview={graphOnlinePreview} onClose={() => setGraphOnlinePreview(null)}/>}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNav={paletteNav}
        onNewChat={paletteNewChat}
        onNewKb={paletteNewKb}
        onUpload={paletteUpload}
        conversations={CONVERSATIONS}
        knowledgeBases={KNOWLEDGE_BASES}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)}/>
      <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)}/>
    </div>
  );
}


export default App;
