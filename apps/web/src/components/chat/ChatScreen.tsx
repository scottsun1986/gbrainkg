"use client";
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from '@/components/common/Icon';
import { TypeBadge, TYPE_BADGE } from '@/components/common/TypeBadge';
import { ScopePicker } from '@/components/common/ScopePicker';
import { ContextMenu } from '@/components/common/ContextMenu';
import { OnlinePreviewModal } from '@/components/preview/UniversalDocumentViewer';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, asRecord, str } from '@/lib/errors';
import { emitToast } from '@/lib/app-events';
import type {
  ChatMessage, Citation, ConversationSummary, CtxMenuItem, KbInfo, PreviewTarget, TraceNode,
} from '@/types';

interface CtxMenuState { x: number; y: number; items: CtxMenuItem[] }

export function ChatScreen(){
  const visibleKbs = appStore.KNOWLEDGE_BASES;
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);   // {role:'user'|'ai', text, done}
  const [streaming, setStreaming] = useState(false);
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<ConversationSummary[]>(appStore.CONVERSATIONS);
  const [convOpen, setConvOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => ({
    '近 7 天': true,
    '30 天内': true,
    '更早': true,
    '未分类': true,
  }));
  const [citations, setCitations] = useState<Citation[]>([]);
  const [onlinePreview, setOnlinePreview] = useState<PreviewTarget | null>(null);
  const [citeCollapsed, setCiteCollapsed] = useState(true);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});
  const [rewriting, setRewriting] = useState(false);
  const [autoStick, setAutoStick] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [hiddenConvs, setHiddenConvs] = useState<Set<string>>(() => new Set<string>());
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamController = useRef<AbortController | null>(null);

  const allSel = selected.length === visibleKbs.length;
  const scopeLabel = allSel ? '我可见的全部' : (selected.length === 0 ? '未选择任何库' : `已选 ${selected.length} 库`);

  // 真实流式输出状态机对接
  useEffect(() => {
    setSelected(visibleKbs.map(k=>k.id));
    setConversationList(appStore.CONVERSATIONS);
    const refresh = () => { setConversationList([...appStore.CONVERSATIONS]); setSelected(visibleKbs.map(k=>k.id)); };
    window.addEventListener('app-data-refresh', refresh);
    return () => window.removeEventListener('app-data-refresh', refresh);
  }, [visibleKbs.length]);

  useEffect(() => {
    const onOpen = (e: Event) => { const detail = (e as CustomEvent<string>).detail; if (detail) void openConversation(detail); };
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

    const updateAssistant = (text: string, done: boolean) => {
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
        let streamError = "";
        let buffer = '';
        let streamFinished = false;

        const consumeLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const payload = trimmed.slice(6).trim();
          if (!payload || payload === '[DONE]') return;
          const data = JSON.parse(payload);
          if (data.type === 'delta') {
            accumulatedText += String(data.content || '');
            updateAssistant(accumulatedText, false);
          } else if (data.type === 'error') {
            streamError = String(data.content || '问答服务返回错误');
            if (!accumulatedText) updateAssistant(streamError, false);
          } else if (data.type === 'conversation') {
            setActiveConv(data.conversation_id);
            setConversationList(list => [{ id: data.conversation_id, title: userMsg.slice(0, 120), createdAt: new Date().toISOString() }, ...list.filter(item => item.id !== data.conversation_id)]);
          } else if (data.type === 'citation') {
            const citation = { id: `${data.index}-${data.topic_slug}`, citationIndex: Number(data.index), title: data.timeline_entry?.doc_title || data.topic_slug || '知识主题', kb: data.timeline_entry?.source_kb, documentId: data.timeline_entry?.document_id, kbName: data.timeline_entry?.kb_name || data.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: '刚刚', snippet: data.timeline_entry?.snippet || '', path: data.topic_slug, pageNo: data.timeline_entry?.page_no, bbox: data.timeline_entry?.bbox };
            setCitations(items => [...items, citation]);
            setMessages(items => {
              const next = [...items];
              const lastIndex = next.map(item => item.role).lastIndexOf('ai');
              if (lastIndex >= 0) next[lastIndex] = { ...next[lastIndex], sources: [...(next[lastIndex].sources || []), citation] };
              return next;
            });
          } else if (data.type === 'trace' && data.node?.id) {
            setMessages(items => {
              const next = [...items];
              const lastIndex = next.map(item => item.role).lastIndexOf('ai');
              if (lastIndex < 0) return items;
              const current = next[lastIndex];
              const trace = Array.isArray(current.trace) ? [...current.trace] : [];
              const nodeIndex = trace.findIndex(node => node.id === data.node.id);
              if (nodeIndex >= 0) trace[nodeIndex] = data.node;
              else trace.push(data.node);
              next[lastIndex] = { ...current, trace, traceId: data.trace_id || current.traceId };
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
        updateAssistant(accumulatedText || streamError, true);
        if (active) setStreaming(false);
      } catch (err) {
         if (active && errorMessage(err) !== 'AbortError' && (err as { name?: string })?.name !== 'AbortError') {
           updateAssistant("大模型请求失败：" + (errorMessage(err) || '未知错误'), true);
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
    setMessages(ms=>[...ms, {role:'user', text}, {role:'ai', text:'', done:false, trace:[]}]);
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

  const copyAnswer = async (text: string) => { try { await navigator.clipboard.writeText(text); window.dispatchEvent(new CustomEvent('app-toast',{detail:'回答已复制'})); } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'复制失败，请检查浏览器权限'})); } };
  const saveFeedback = async (feedback: string) => {
    if (!activeConv) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}` ,{headers:apiHeaders()});
      const conversation = await response.json(); const message = [...(conversation.messages || [])].reverse().find(item=>item.role==='assistant');
      if (message) { await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}/messages/${message.id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({feedback})}); window.dispatchEvent(new CustomEvent('app-toast',{detail:'反馈已记录'})); }
    } catch {}
  };

  const previewCitation = (citation: Citation) => {
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
      pageNo: (citation.pageNo ?? citation.page_no) as number | string | undefined,
      bbox: citation.bbox,
    });
  };

  const openConversation = async (id: string) => {
    if (streaming || !id) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('会话加载失败');
      const conversation = await response.json();
      setActiveConv(id);
      setMessages((conversation.messages || []).map((message: any) => ({
        role: message.role === 'assistant' ? 'ai' : 'user',
        text: message.content,
        done: true,
        trace: message.role === 'assistant' && Array.isArray(message.processingTrace) ? message.processingTrace : [],
        sources: message.role === 'assistant' && Array.isArray(message.citationsSummary) ? message.citationsSummary.map((cite: any, index: number) => ({ id: `${message.id}-${index}`, citationIndex: Number(cite.index || index + 1), title: cite.timeline_entry?.doc_title || cite.topic_slug || '知识主题', kb: cite.timeline_entry?.source_kb, documentId: cite.timeline_entry?.document_id, kbName: cite.timeline_entry?.kb_name || cite.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: new Date(message.createdAt).toLocaleString('zh-CN'), snippet: cite.timeline_entry?.snippet || '', path: cite.topic_slug, pageNo: cite.timeline_entry?.page_no, bbox: cite.timeline_entry?.bbox })) : [],
      })));
      setCitations((conversation.messages || []).flatMap((message: any) => Array.isArray(message.citationsSummary) ? message.citationsSummary.map((cite: any, index: number) => ({ id: `${message.id}-${index}`, citationIndex: Number(cite.index || index + 1), title: cite.timeline_entry?.doc_title || cite.topic_slug || '知识主题', kb: cite.timeline_entry?.source_kb, documentId: cite.timeline_entry?.document_id, kbName: cite.timeline_entry?.kb_name || cite.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: new Date(message.createdAt).toLocaleString('zh-CN'), snippet: cite.timeline_entry?.snippet || '', pageNo: cite.timeline_entry?.page_no, bbox: cite.timeline_entry?.bbox })) : []));
    } catch (error) { window.dispatchEvent(new CustomEvent('app-toast', {detail: errorMessage(error) || '会话加载失败'})); }
  };

  const hideConversation = (conv: ConversationSummary) => {
    const id = conv?.id;
    if (!id) return;
    const next = new Set(hiddenConvs); next.add(id); setHiddenConvs(next);
    if (activeConv === id) { setMessages([]); setActiveConv(null); setCitations([]); }
    const onUndo = () => { const r = new Set(hiddenConvs); r.delete(id); setHiddenConvs(r); };
    const evt = new CustomEvent('app-undoable', { detail: { message: `已隐藏会话：${(conv.title || '未命名').slice(0, 20)}`, undoLabel: '撤销', undo: onUndo } });
    window.dispatchEvent(evt);
  };

  const renameConversation = async (conv: ConversationSummary) => {
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

  const showConvMenu = (e: React.MouseEvent, conv: ConversationSummary) => {
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

  const autoGrow = (el: HTMLTextAreaElement)=>{
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const renderAnswer = (typed: string, msgSources?: Citation[]) => {
    // 渲染 typed 文本：处理 **粗体** 与 [n] 引用 chip
    const out: React.ReactNode[] = [];
    let key = 0;
    const segs = typed.split(/(\*\*[^*]+\*\*)/g);
    segs.forEach((seg: string) => {
      if(!seg) return;
      const isBold = /^\*\*[^*]+\*\*$/.test(seg);
      const text = isBold ? seg.slice(2,-2) : seg;
      const wrap = (s: string, k: number) => isBold ? <strong key={k}>{s}</strong> : <span key={k}>{s}</span>;
      const re = /\[(\d+)\]/g; let last = 0; let m;
      while((m = re.exec(text)) !== null){
        if(m.index > last) out.push(wrap(text.slice(last, m.index), key++));
        const n = parseInt(m[1],10);
        const activeSources = (msgSources && msgSources.length > 0) ? msgSources : citations;
        const citation = activeSources.find((source: Citation) => Number(source.citationIndex) === n) || activeSources[n-1];
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
      {convOpen && <div className="conv-backdrop" onClick={() => setConvOpen(false)} />}
      <div className={`conv-side ${convOpen ? 'open' : ''}`}>
        <div className="scope">
          <div className="scope-label">查询范围</div>
          <ScopePicker visibleKbs={visibleKbs} selected={selected} setSelected={setSelected} open={open} setOpen={setOpen}/>
        </div>
        <div className="conv-head">
          <h4>最近会话</h4>
          <div style={{display:'flex',alignItems:'center',gap:4}}>
            <button className="icon-btn" title="新建会话 (⌘N)" onClick={()=>{ newChat(); setConvOpen(false); }}><Icon name="plus" size={14}/></button>
            <button type="button" className="icon-btn conv-close-btn" title="关闭会话列表" aria-label="关闭会话列表" onClick={() => setConvOpen(false)}><Icon name="x" size={14}/></button>
          </div>
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
              { label: '昨天', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < startOfTodayMs && new Date(c.createdAt).getTime() >= startOfTodayMs - 86400000) },
              { label: '近 7 天', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < startOfTodayMs - 86400000 && new Date(c.createdAt).getTime() >= sevenDaysAgoMs) },
              { label: '30 天内', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < sevenDaysAgoMs && new Date(c.createdAt).getTime() >= thirtyDaysAgoMs) },
              { label: '更早', items: filtered.filter((c) => c.createdAt && new Date(c.createdAt).getTime() < thirtyDaysAgoMs) },
              { label: '未分类', items: filtered.filter((c) => !c.createdAt) },
            ].filter((g) => g.items.length > 0);
            if (groups.length === 0) return <div className="conv-empty">{q ? '没有匹配的会话' : '暂无会话'}</div>;
            return groups.map((g) => {
              const hasActive = g.items.some((c) => c.id === activeConv);
              const isCollapsed = !q && !hasActive && Boolean(collapsedGroups[g.label as keyof typeof collapsedGroups]);
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
                        <div key={c.id} className={`conv-item ${activeConv===c.id?'active':''}`} onClick={()=>{ openConversation(c.id); setConvOpen(false); }} onContextMenu={(e) => showConvMenu(e, c)}>
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
        <div className="new-chat" onClick={()=>{ newChat(); setConvOpen(false); }} title="开始一段新对话 (⌘N)">
          <Icon name="plus" size={12}/> 新建会话
        </div>
      </div>

      <div className="chat-main">
        <div className="conv-mobile-bar">
          <button type="button" className="chat-mobile-conv-btn" onClick={() => setConvOpen(true)}>
            <Icon name="chat" size={13}/>
            <span>会话列表 ({conversationList.length})</span>
          </button>
        </div>
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
              const traceNodes = Array.isArray(msg.trace) ? msg.trace : [];
              const traceSuccess = traceNodes.filter((node: TraceNode) => node.status === 'success' || node.status === 'skipped').length;
              const traceWarnings = traceNodes.filter((node: TraceNode) => node.status === 'warning').length;
              const traceFailed = traceNodes.filter((node: TraceNode) => node.status === 'failed').length;
              const traceRunning = traceNodes.filter((node: TraceNode) => node.status === 'running').length;
              const traceStarted = traceNodes.map((node: TraceNode) => Date.parse(node.startedAt || '')).filter(Number.isFinite);
              const traceFinished = traceNodes.map((node: TraceNode) => Date.parse(node.finishedAt || '')).filter(Number.isFinite);
              const traceDuration = traceStarted.length && traceFinished.length
                ? Math.max(0, Math.max(...traceFinished) - Math.min(...traceStarted))
                : null;
              return (
                <div key={mi} className="msg msg-ai">
                  <div className="body">
                    <div className="who">
                      <span className="dot"/>
                      <span>百纳 · 大脑综述</span>
                      <span style={{color:'var(--ink-4)'}}>· 你的大脑 · {scopeLabel}{allSel ? `（${selected.length} 库）` : ''}</span>
                    </div>
                    <div className="answer">
                      {renderAnswer(msg.text, msg.sources)}
                      {!msg.done && <span className="cursor"/>}
                    </div>
                    {msg.done && (msg.sources?.length ?? 0) > 0 && <div className="answer-sources"><span>来源：</span>{(msg.sources || []).map((source: Citation, index: number) => <button key={source.id || index} onClick={()=>previewCitation(source)} title="打开原始文档预览">[{source.citationIndex || index + 1}] {source.title}</button>)}</div>}
                    {traceNodes.length > 0 && (
                      <details className="retrieval">
                        <summary>
                          <Icon name="spark" size={12} color="var(--evidence)"/>
                          <span>本次响应处理调用链 ·</span>
                          <b>{traceFailed ? `${traceFailed} 个异常` : traceRunning ? `${traceRunning} 个执行中` : `${traceSuccess}/${traceNodes.length} 个节点正常`}</b>
                          {traceWarnings > 0 && <span className="trace-summary-warning">· {traceWarnings} 个警告</span>}
                          {traceDuration !== null && <span className="trace-total">{traceDuration}ms</span>}
                          <span className="trace-expand">展开 ▾</span>
                        </summary>
                        <div className="retrieval-body">
                          {traceNodes.map((node: TraceNode, index: number) => (
                            <div className={`ret-step trace-${String(node.status ?? '')}`} key={node.id || index}>
                              <span className="n">{node.status === 'success' ? '✓' : node.status === 'warning' ? '!' : node.status === 'failed' ? '×' : node.status === 'skipped' ? '–' : '…'}</span>
                              <span className="txt">
                                <b>{String(node.name ?? '')}</b>
                                {node.summary ? ` · ${String(node.summary ?? '')}` : ''}
                                {node.details && Object.keys(node.details).length > 0 && (
                                  <details className="trace-details">
                                    <summary>查看节点反馈</summary>
                                    <pre>{JSON.stringify(node.details, null, 2)}</pre>
                                  </details>
                                )}
                              </span>
                              <span className="v">{node.status === 'running' ? '执行中' : node.status === 'skipped' ? '跳过' : `${node.durationMs ?? 0}ms`}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {msg.done && (
                      <>
                        <div className="actions">
                          <button onClick={()=>copyAnswer(msg.text)}><Icon name="copy" size={12}/> 复制</button>
                          <button onClick={()=>send([...messages].reverse().find(item=>item.role==='user')?.text)}><Icon name="refresh" size={12}/> 重写</button>
                          <button style={{marginLeft:'auto'}} onClick={()=>saveFeedback('useful')}><Icon name="check" size={12}/> 有用</button>
                        </div>
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
                const kb = appStore.KNOWLEDGE_BASES.find(k=>k.id===c.kb) || {
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

