"use client";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { TypeBadge, TYPE_BADGE } from '@/components/common/TypeBadge';
import { OnlinePreviewModal } from '@/components/preview/UniversalDocumentViewer';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitUndoable, emitDataRefresh } from '@/lib/app-events';
import { hasCapability } from '@/lib/capabilities';
import { TextKnowledgeModal } from '@/components/admin/IndustryKBPanel';
import type {
  DocChunk, KbInfo, PreviewTarget,
} from '@/types';

interface DocRow {
  id: string;
  name: string;
  type: string;
  size: string;
  status: string;
  uploader: string;
  t: string;
  path: string;
  content?: string;
  qualityIssues?: string[];
  parserEngine?: string;
  [key: string]: unknown;
}

export function LibrariesScreen({onManageGrant, initialKbId, capabilities = [], active = true}: { onManageGrant?: (kb: KbInfo) => void; initialKbId?: string | null; capabilities?: string[]; active?: boolean }){
  // 多屏常驻挂载下本组件虽 display:none 但也会执行 effect；文档列表按
  // 首次可见再拉取，避免启动即请求全部知识库文档拖慢首屏。
  const [hasBeenActive, setHasBeenActive] = useState(Boolean(active));
  useEffect(() => { if (active) setHasBeenActive(true); }, [active]);
  const [filter, setFilter] = useState('all');
  const filtered = filter==='all' ? appStore.KNOWLEDGE_BASES : appStore.KNOWLEDGE_BASES.filter(k=>k.type===filter);
  const [sel, setSel] = useState<KbInfo | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [tab, setTab] = useState('docs');
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [previewDoc, setPreviewDoc] = useState<DocRow | null>(null);
  const [onlinePreview, setOnlinePreview] = useState<PreviewTarget | null>(null);
  const [confirmDoc, setConfirmDoc] = useState<DocRow | null>(null);
  const [confirmKb, setConfirmKb] = useState<KbInfo | null>(null);
  const [newPersonalOpen, setNewPersonalOpen] = useState(false);
  const [newTextOpen, setNewTextOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  // Server-side document pagination + filtering. The API already supports
  // page/limit/search/status, but the page used to omit them and then paginate
  // client-side over the API's default 50-row response — so any knowledge base
  // silently capped at 50 documents in the management view.
  const loadDocuments = async (kbId: string, opts: { page?: number; limit?: number; search?: string; status?: string } = {}) => {
    if (!kbId) { setDocs([]); setDocsTotal(0); return; }
    const page = opts.page ?? docPage;
    const limit = opts.limit ?? docPageSize;
    const search = opts.search ?? docSearch;
    const status = opts.status ?? docStatusFilter;
    try {
      const params = new URLSearchParams();
      params.set('page', String(page || 1));
      params.set('limit', String(limit || 50));
      if (search && String(search).trim()) params.set('search', String(search).trim());
      if (status && status !== 'all') params.set('status', String(status));
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents?${params.toString()}`, {headers:apiHeaders()});
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
          qualityStatus: doc.qualityStatus || 'unknown',
          qualityScore: doc.qualityScore,
          qualityIssues: Array.isArray(doc.qualityIssues) ? doc.qualityIssues : [],
          parserEngine: doc.parserEngine,
        };
      }));
      setDocsTotal(Number(result.total) || 0);
      setDocsStatusCounts(result.statusCounts || {});
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail: errorMessage(error) || '文档加载失败'})); }
  };

  // Export the WHOLE current filtered view, not just the visible page.
  const exportAllDocuments = async () => {
    if (!current?.id) return;
    try {
      const rows: Array<{ name: string; status: string; path: string }> = [];
      const limit = 100;
      let page = 1;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 2000) break; // safety cap (~200k rows)
        const params = new URLSearchParams({ page: String(page), limit: String(limit) });
        if (docSearch && docSearch.trim()) params.set('search', docSearch.trim());
        if (docStatusFilter && docStatusFilter !== 'all') params.set('status', docStatusFilter);
        const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents?${params.toString()}`, { headers: apiHeaders() });
        if (!response.ok) throw new Error('导出失败');
        const data = await response.json();
        const items = data.items || [];
        for (const doc of items) {
          const path = doc.mdPath || '';
          const baseName = path.split('/').pop() || path;
          const original = doc.title && !doc.title.includes('/') ? doc.title : baseName;
          rows.push({ name: original, status: doc.status, path });
        }
        if (items.length < limit || rows.length >= Number(data.total || 0)) break;
        page += 1;
      }
      const csv = ['文档,状态,路径', ...rows.map((r) => `${JSON.stringify(r.name)},${r.status},${JSON.stringify(r.path || '')}`)].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${current.name}-documents.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(error) || '导出失败' })); }
  };

  useEffect(() => {
    if (!current && filtered[0]) setSel(filtered[0]);
    if (!filtered.length && sel) setSel(null);
  }, [filter, filtered.length, filtered[0]?.id, current?.id]);
  useEffect(() => { const target = appStore.KNOWLEDGE_BASES.find(k => k.id === initialKbId); if (target) setSel(target); }, [initialKbId]);


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

      const isArchive = result.isArchive || (result.documents && result.documents.length > 1);
      if (isArchive) {
        // 压缩包已在后端自动解压，压缩包本身已物理删除；移除压缩包占位行并提示提取的文档数量
        setDocs((ds) => ds.filter((d) => d.id !== tempId));
        const count = result.documents?.length || result.total || 0;
        window.dispatchEvent(
          new CustomEvent('app-toast', {
            detail: `「${tempName}」解压成功，已提取 ${count} 篇文档并开始逐一解析`,
          }),
        );
      } else {
        const doc = result.documents?.[0];
        if (doc) {
          setDocs((ds) => ds.map((d) => (d.id === tempId ? { ...d, id: doc.id, status: doc.status || 'parsing' } : d)));
        }
        window.dispatchEvent(new CustomEvent('app-toast', { detail: `「${tempName}」已上传，后台正在解析与索引` }));
      }
      await loadDocuments(current.id);
    } catch (error: unknown) {
      setDocs((ds) => ds.map((d) => (d.id === tempId ? { ...d, status: 'failed' } : d)));
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(error) || '上传失败' }));
    }
  };

  const [docSearch, setDocSearch] = useState('');
  const [docStatusFilter, setDocStatusFilter] = useState('all');
  const [docTypeFilter, setDocTypeFilter] = useState('all');
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(10);
  const [docsTotal, setDocsTotal] = useState(0);
  // Whole-KB status counts from the API (server-side), so the summary cards,
  // tab badge, health panel and processing poller never depend on how many
  // rows happen to be on the current page.
  const [docsStatusCounts, setDocsStatusCounts] = useState<Record<string, number>>({});

  // 针对处理中（parsing / indexing）文档进行后台轻量级自动轮询，动态更新状态，完全不阻塞上传按钮与区域
  const hasProcessingDocs =
    Number(docsStatusCounts.processing || 0) > 0 ||
    docs.some((d: any) => d.status === 'parsing' || d.status === 'indexing' || String(d.id).startsWith('temp-'));

  useEffect(() => {
    if (!hasProcessingDocs || !current?.id) return;
    const timer = setInterval(() => {
      loadDocuments(current.id, { page: docPage, limit: docPageSize, search: docSearch, status: docStatusFilter });
    }, 2000);
    return () => clearInterval(timer);
  }, [hasProcessingDocs, current?.id, docPage, docPageSize, docSearch, docStatusFilter]);

  useEffect(() => {
    setDocPage(1);
  }, [current?.id, docSearch, docStatusFilter, docPageSize]);

  // Fetch the current server page whenever the KB, page, page size or
  // status/search filters change (search is debounced).
  useEffect(() => {
    if (!hasBeenActive || !current?.id) return;
    const timer = setTimeout(
      () => void loadDocuments(current.id, { page: docPage, limit: docPageSize, search: docSearch, status: docStatusFilter }),
      docSearch ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [hasBeenActive, current?.id, docPage, docPageSize, docSearch, docStatusFilter]);

  useEffect(() => {
    const refresh = () => {
      if (hasBeenActive && current?.id) {
        void loadDocuments(current.id, { page: docPage, limit: docPageSize, search: docSearch, status: docStatusFilter });
      }
    };
    window.addEventListener('app-data-refresh', refresh);
    return () => window.removeEventListener('app-data-refresh', refresh);
  }, [hasBeenActive, current?.id, docPage, docPageSize, docSearch, docStatusFilter]);

  // File-type filtering has no server-side counterpart, so it is applied to
  // the current server page only (status/search are already server-side).
  const pagedDocs = useMemo(() => {
    if (docTypeFilter === 'all') return docs;
    return docs.filter((d: any) => {
      const ext = (d.name || '').split('.').pop()?.toLowerCase() || '';
      if (docTypeFilter === 'word' && !['doc', 'docx'].includes(ext)) return false;
      if (docTypeFilter === 'pdf' && ext !== 'pdf') return false;
      if (docTypeFilter === 'excel' && !['xlsx', 'xls', 'csv'].includes(ext)) return false;
      if (docTypeFilter === 'md' && !['md', 'txt', 'markdown'].includes(ext)) return false;
      return true;
    });
  }, [docs, docTypeFilter]);

  const totalDocs = docsTotal;
  const docTotalPages = Math.max(1, Math.ceil(totalDocs / docPageSize));
  const currentDocPage = Math.min(docPage, docTotalPages);

  // Server-side whole-KB counters (never derived from the current page).
  const statTotal = Number(docsStatusCounts.total ?? docsTotal) || 0;
  const statPublished = Number(docsStatusCounts.published || 0);
  const statProcessing = Number(docsStatusCounts.processing || 0);
  const statNeedsReview = Number(docsStatusCounts.needs_review || 0);
  const statFailed = Number(docsStatusCounts.failed || 0);

  const previewDocument = (doc: DocRow) => {
    setOnlinePreview({ kbId: current.id, docId: doc.id, title: doc.name || String(doc.title || '') || '原始文档' });
  };

  const deleteDocument = async (doc: DocRow) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/${doc.id}`, {method:'DELETE',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '删除失败');
      setConfirmDoc(null);
      await loadDocuments(current.id);
      window.dispatchEvent(new CustomEvent('app-toast', {detail:'知识已删除'}));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail:errorMessage(error) || '删除失败'})); }
  };

  const addTextDocument = async ({title, content}: { title: string; content: string }) => {
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
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '文本知识保存失败'})); }
  };

  return (
    <div className={`lib ${mobileDetailOpen ? 'detail-active' : ''}`}>
      <div className="lib-list">
        <div className="lib-head" style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{flex:1}}><h3>知识库</h3><p>共 {appStore.KNOWLEDGE_BASES.length} 个 · 你可见 {appStore.KNOWLEDGE_BASES.length} 个</p></div>
          <button className="btn" onClick={()=>setNewPersonalOpen(true)}>+ 新建个人库</button>
        </div>
        <div className="lib-tabs">
          {[
            {k:'all', l:'全部', n:appStore.KNOWLEDGE_BASES.length},
            {k:'personal', l:'个人', n:appStore.KNOWLEDGE_BASES.filter(k=>k.type==='personal').length},
            {k:'org', l:'组织', n:appStore.KNOWLEDGE_BASES.filter(k=>k.type==='org').length},
            {k:'industry', l:'行业', n:appStore.KNOWLEDGE_BASES.filter(k=>k.type==='industry').length},
          ].map(t=>(
            <div key={t.k} className={`lib-tab ${filter===t.k?'active':''}`} onClick={()=>setFilter(t.k)}>
              <span>{t.l}</span><span className="n">{t.n}</span>
            </div>
          ))}
        </div>
        <div className="lib-body">
          {filtered.length ? filtered.map(k=>(
            <div key={k.id} className={`kb-card ${current?.id===k.id?'active':''}`} onClick={()=>{ setSel(k); setMobileDetailOpen(true); }}>
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
            <button type="button" className="lib-back-btn" onClick={() => setMobileDetailOpen(false)}>
              <Icon name="arrowleft" size={13}/>
              <span>返回知识库列表</span>
            </button>
            <div className="ttl">{current.name}</div>
            <div className="sub">
              {TYPE_BADGE(current.type)}
              <span><Icon name={current.type==='personal'?'lock':current.type==='org'?'users':'shield'} size={11}/> 可见范围：{current.visibility}</span>
              <span><Icon name="doc" size={11}/> {statTotal} 文档</span>
              <span>· Embedding：<b style={{color:'var(--ink)'}}>bge-m3</b> · 1024 维</span>
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={()=>exportAllDocuments()}>导出</button>
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
              accept=".md,.txt,.csv,.html,.htm,.doc,.docx,.pdf,.xls,.xlsx,.pptx,.png,.jpg,.jpeg,.zip,.tar,.tar.gz,.tgz"
            />
            {current.canWrite && <button className="btn" onClick={()=>setNewTextOpen(true)}><Icon name="plus" size={12}/> 添加文本</button>}
            {current.canWrite && <button className="btn primary" onClick={()=>fileInputRef.current?.click()}><Icon name="upload" size={12}/> 上传文档</button>}
          </div>
        </div>
        <div className="detail-tabs">
          <div className={`detail-tab ${tab==='docs'?'active':''}`} onClick={()=>setTab('docs')}>文档（{statTotal}）</div>
          <div className={`detail-tab ${tab==='health'?'active':''}`} onClick={()=>setTab('health')}>健康度</div>
          <div className={`detail-tab ${tab==='settings'?'active':''}`} onClick={()=>setTab('settings')}>设置</div>
        </div>
        <div className="detail-body">
          {tab==='docs' && <>
          {current.canWrite ? (
            <div
              className="compact-dropzone"
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
              title="拖拽文件到此处，或点击上传"
            >
              <div className="compact-dropzone-icon">
                <Icon name="upload" size={18}/>
              </div>
              <div className="compact-dropzone-info">
                <div className="compact-dropzone-title">
                  <span>拖拽文件到此处快速入库，或点击选择</span>
                  <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ink-4)', background: 'var(--line-2)', padding: '1px 6px', borderRadius: '4px' }}>
                    PDF · Word · PPT · Excel · Markdown · 压缩包(ZIP/TAR)
                  </span>
                </div>
                <div className="compact-dropzone-sub">
                  支持多选批量上传及 ZIP/TAR 压缩包（自动解压并逐一解析，压缩包自动删除）· 单文件最大 200MB
                </div>
              </div>
              <button type="button" className="compact-dropzone-btn" onClick={(e)=>{ e.stopPropagation(); fileInputRef.current?.click(); }}>
                <Icon name="plus" size={12} color="#fff"/> 上传文档
              </button>
            </div>
          ) : (
            <div className="compact-dropzone" style={{cursor:'default',opacity:.8}}>
              <div className="compact-dropzone-icon" style={{color:'var(--ink-4)'}}>
                <Icon name="lock" size={18}/>
              </div>
              <div className="compact-dropzone-info">
                <div className="compact-dropzone-title">当前账号仅可阅读</div>
                <div className="compact-dropzone-sub">只有知识库所有者或管理员可以上传、删除知识。</div>
              </div>
            </div>
          )}

          <div className="kpi-row">
            <div
              className={`kpi interactive ${docStatusFilter==='all'?'active':''}`}
              onClick={()=>setDocStatusFilter('all')}
              title="点击查看全部状态文档"
              role="button"
              tabIndex={0}
            >
              <div className="lbl">
                <span>总文档</span>
                {docStatusFilter==='all' && <span className="kpi-indicator">全部</span>}
              </div>
              <div className="val">{statTotal}</div>
              <div className="sub">全部已收录条目</div>
            </div>

            <div
              className={`kpi interactive ${docStatusFilter==='published'?'active':''}`}
              onClick={()=>setDocStatusFilter(f => f === 'published' ? 'all' : 'published')}
              title="点击过滤：仅显示已发布文档 (再次点击取消)"
              role="button"
              tabIndex={0}
            >
              <div className="lbl">
                <span>已发布</span>
                {docStatusFilter==='published' && <span className="kpi-indicator">已选</span>}
              </div>
              <div className="val" style={{color: 'var(--ink)'}}>{statPublished}</div>
              <div className="sub">已完成检索就绪</div>
            </div>

            <div
              className={`kpi interactive ${docStatusFilter==='indexing'||docStatusFilter==='parsing'?'active':''}`}
              onClick={()=>setDocStatusFilter(f => (f === 'indexing' || f === 'parsing') ? 'all' : 'indexing')}
              title="点击过滤：仅显示处理中任务 (再次点击取消)"
              role="button"
              tabIndex={0}
            >
              <div className="lbl">
                <span>处理中</span>
                {(docStatusFilter==='indexing'||docStatusFilter==='parsing') && <span className="kpi-indicator">已选</span>}
              </div>
              <div className="val">{statProcessing}</div>
              <div className="sub">解析 / 索引队列</div>
            </div>

            <div
              className={`kpi interactive ${docStatusFilter==='needs_review'?'active':''}`}
              onClick={()=>setDocStatusFilter(f => f === 'needs_review' ? 'all' : 'needs_review')}
              title="点击过滤：仅显示待复核文档 (再次点击取消)"
              role="button"
              tabIndex={0}
            >
              <div className="lbl">
                <span>待复核</span>
                {docStatusFilter==='needs_review' && <span className="kpi-indicator">已选</span>}
              </div>
              <div className="val" style={{color: statNeedsReview? 'var(--amber)':'var(--ink)'}}>
                {statNeedsReview}
              </div>
              <div className="sub">质量门禁暂缓发布</div>
            </div>

            <div
              className={`kpi interactive ${docStatusFilter==='failed'?'active':''}`}
              onClick={()=>setDocStatusFilter(f => f === 'failed' ? 'all' : 'failed')}
              title="点击过滤：仅显示解析失败文档 (再次点击取消)"
              role="button"
              tabIndex={0}
            >
              <div className="lbl">
                <span>解析失败</span>
                {docStatusFilter==='failed' && <span className="kpi-indicator">已选</span>}
              </div>
              <div className="val" style={{color: statFailed? 'var(--danger)':'var(--ink)'}}>
                {statFailed}
              </div>
              <div className="sub">需人工介入排查</div>
            </div>
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
              <option value="needs_review">待复核</option>
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
              <option value="excel">Excel (.xls / .xlsx / .csv)</option>
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
              本页 {pagedDocs.length} 篇 · 共 {docsTotal} 篇文档
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
                  <div style={{ cursor: 'pointer', minWidth: 0 }} onClick={() => previewDocument(d)} title="点击预览文档与标准知识页">
                    <div className="ttl" title={d.name}>{d.name}</div>
                    <div className="sub" title={d.path}>{d.path}</div>
                  </div>
                  <div>
                    <span className={`status ${d.status}`} title={d.qualityIssues?.length ? d.qualityIssues.join('；') : (d.parserEngine ? `解析引擎：${d.parserEngine}` : '')}>
                      <span className="d"/>
                      {d.status==='published'?'已发布':d.status==='indexing'?'索引中':d.status==='parsing'?'解析中':d.status==='needs_review'?'待复核':'失败'}
                    </span>
                  </div>
                  <div style={{color:'var(--ink-2)'}}>{d.uploader}<div style={{fontSize:10.5,color:'var(--ink-4)'}}>{d.t}</div></div>
                  <div style={{color:'var(--ink-3)',fontVariantNumeric:'tabular-nums'}}>{d.size}</div>
                  <div className="actions" style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                    <button className="icon-btn" title="预览" onClick={()=>previewDocument(d)} aria-label="预览"><Icon name="search" size={14}/></button>
                    {current.canWrite && (d.status==='failed' || d.status==='needs_review') && !String(d.id).startsWith('temp-') && <button className="icon-btn" title="重试" onClick={async()=>{try{const response=await fetch(`${API_BASE_URL}/api/v1/kbs/${current.id}/documents/${d.id}/retry`,{method:'POST',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'重试失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'已重新提交解析'})); await loadDocuments(current.id);}catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error)||'重试失败'}));}}} aria-label="重试"><Icon name="refresh" size={14}/></button>}
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
          {tab==='health' && <div style={{padding:24}}><h3>知识库健康度</h3><p style={{color:'var(--ink-3)'}}>健康度根据当前数据库中的文档状态与解析质量门禁计算。</p><div className="kpi-row"><div className="kpi"><div className="lbl">已发布率</div><div className="val">{statTotal ? Math.round(statPublished/statTotal*100) : 0}%</div></div><div className="kpi"><div className="lbl">待复核</div><div className="val">{statNeedsReview}</div></div><div className="kpi"><div className="lbl">失败文档</div><div className="val">{statFailed}</div></div><div className="kpi"><div className="lbl">待处理</div><div className="val">{statProcessing}</div></div></div></div>}
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
      {confirmKb && <ConfirmModal title="删除个人知识库" msg={<>确认删除个人知识库 <b style={{color:'var(--ink)'}}>{confirmKb.name}</b>？其中的知识将一并删除。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/kbs/personal/${confirmKb.id}`,{method:'DELETE',headers:apiHeaders()}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'删除失败'); setConfirmKb(null); setSel(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmKb(null)}/>}
      {newTextOpen && <TextKnowledgeModal onClose={()=>setNewTextOpen(false)} onSave={addTextDocument}/>}
      {newPersonalOpen && <NewPersonalKBModal onClose={()=>setNewPersonalOpen(false)} onSaved={()=>{setNewPersonalOpen(false); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
    </div>
  );
}

export function NewPersonalKBModal({onClose, onSaved}: { onClose: () => void; onSaved?: () => void }){
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kbs/personal`, {method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name:name.trim(),description:description.trim(),type:'personal'})});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '创建失败');
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'个人知识库已创建'})); onSaved?.();
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '创建失败'})); }
    finally { setSaving(false); }
  };
  return <Modal title="新建个人知识库" onClose={onClose} foot={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={saving || !name.trim()} onClick={save}>{saving?'创建中…':'创建'}</button></>}>
    <div className="field"><label>名称<span className="req">*</span></label><input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="如：我的项目笔记"/></div>
    <div className="field"><label>描述</label><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="说明这个个人库的用途"/></div>
    <div className="field-hint">个人知识库仅本人可见，不支持共享和授权。</div>
  </Modal>;
}

/* ============== 管理后台 ============== */
