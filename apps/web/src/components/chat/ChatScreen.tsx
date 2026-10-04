"use client";
import React, { useState, useEffect, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import dynamic from 'next/dynamic';
import { Icon } from '@/components/common/Icon';
import { TypeBadge, TYPE_BADGE } from '@/components/common/TypeBadge';
import { ScopePicker } from '@/components/common/ScopePicker';
import { ContextMenu } from '@/components/common/ContextMenu';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, asRecord, str } from '@/lib/errors';
import { registerRun, rekeyRun, runOwnsView, unregisterRun, type StreamRunLike } from '@/lib/stream-registry';
import { emitToast } from '@/lib/app-events';
import { AnswerMarkdown } from './AnswerMarkdown';
import type {
  ChatMessage, Citation, ConversationSummary, CtxMenuItem, KbInfo, PreviewTarget, TraceNode,
} from '@/types';

// 预览弹窗挂载了 docx/ppt 解析链路，仅在用户点开引用预览时才加载对应分包。
const OnlinePreviewModal = dynamic(() => import('@/components/preview/UniversalDocumentViewer').then((m) => ({ default: m.OnlinePreviewModal })), { ssr: false });

interface CtxMenuState { x: number; y: number; items: CtxMenuItem[] }

interface ConversationCitationPayload {
  index?: number;
  topic_slug?: string;
  timeline_entry?: {
    doc_title?: string;
    source_kb?: string;
    document_id?: string;
    kb_name?: string;
    snippet?: string;
    page_no?: number | string;
    bbox?: Citation['bbox'];
  };
}
interface ConversationMessagePayload {
  id?: string;
  role?: string;
  content?: string;
  createdAt?: string;
  citationsSummary?: ConversationCitationPayload[];
}
interface ConversationPayload { messages?: ConversationMessagePayload[] }

type StreamRun = StreamRunLike;

function mapCitation(cite: ConversationCitationPayload, messageId: string | undefined, index: number): Citation {
  const entry = cite.timeline_entry;
  return {
    id: `${messageId ?? 'm'}-${index}`,
    citationIndex: Number(cite.index || index + 1),
    title: entry?.doc_title || cite.topic_slug || '知识主题',
    kb: entry?.source_kb ?? '',
    documentId: entry?.document_id ?? '',
    kbName: entry?.kb_name || entry?.source_kb || '知识库',
    truth: '—',
    evidences: 1,
    lastUpdate: '',
    snippet: entry?.snippet || '',
    path: cite.topic_slug ?? '',
    pageNo: entry?.page_no,
    bbox: entry?.bbox,
  };
}

/** 会话消息 → 视图模型。trace 一律留空：processingTrace 不再随会话列表
 *  下发（单条可达百 KB），调用链改为展开 TraceDetails 时按需拉取。 */
function mapConversationMessages(conversation: ConversationPayload): ChatMessage[] {
  return (conversation.messages || []).map((message) => {
    const cites = Array.isArray(message.citationsSummary) ? message.citationsSummary : [];
    return {
      id: message.id,
      role: message.role === 'assistant' ? 'ai' : 'user',
      text: String(message.content ?? ''),
      done: true,
      trace: [],
      sources: message.role === 'assistant' ? cites.map((cite, index) => mapCitation(cite, message.id, index)) : [],
    };
  });
}

function collectConversationCitations(conversation: ConversationPayload): Citation[] {
  return (conversation.messages || []).flatMap((message) =>
    Array.isArray(message.citationsSummary)
      ? message.citationsSummary.map((cite, index) => mapCitation(cite, message.id, index))
      : [],
  );
}

export function ChatScreen(){
  const visibleKbs = appStore.KNOWLEDGE_BASES;
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);   // {role:'user'|'ai', text, done}
  // 每条流各持一份控制器与收尾函数，按会话 id（或草稿键）索引，可并发。
  // 单例版本只能容纳一条流：第二条流的启动信号与第一条相同，被 React 丢弃。
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<ConversationSummary[]>(appStore.CONVERSATIONS);
  const [convOpen, setConvOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  // 侧栏只加载首页（30 条），更早的会话按需翻页。
  const [convMore, setConvMore] = useState(() => appStore.CONVERSATIONS_META?.hasMore ?? false);
  const [convCursor, setConvCursor] = useState<string | null>(() => appStore.CONVERSATIONS_META?.nextCursor ?? null);
  const [convMoreLoading, setConvMoreLoading] = useState(false);
  const loadMoreConversations = useCallback(async () => {
    if (convMoreLoading || !convMore || !convCursor) return;
    setConvMoreLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/conversations?paginated=1&limit=30&before=${encodeURIComponent(convCursor)}`, { headers: apiHeaders() });
      if (!res.ok) return;
      const page = (await res.json()) as { items?: ConversationSummary[]; nextCursor?: string | null; hasMore?: boolean };
      const items = Array.isArray(page?.items) ? page.items : [];
      setConversationList(prev => {
        const seen = new Set(prev.map(c => c.id));
        return [...prev, ...items.filter(c => !seen.has(c.id))];
      });
      setConvMore(page?.hasMore === true);
      setConvCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : null);
    } catch {} finally { setConvMoreLoading(false); }
  }, [convMore, convCursor, convMoreLoading]);
  const [collapsedGroups, setCollapsedGroups] = useState(() => ({
    '近 7 天': true,
    '30 天内': true,
    '更早': true,
    '未分类': true,
  }));
  const [citations, setCitations] = useState<Citation[]>([]);
  const [onlinePreview, setOnlinePreview] = useState<PreviewTarget | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [citeCollapsed, setCiteCollapsed] = useState(true);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});
  const [rewriting, setRewriting] = useState(false);
  const [autoStick, setAutoStick] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [hiddenConvs, setHiddenConvs] = useState<Set<string>>(() => new Set<string>());
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openSeqRef = useRef(0);
  /**
   * 每个会话一条独立的流。新建会话时服务端还没分配 id，先用客户端序号做临时
   * 键，收到 `conversation` 事件后重键为真实 id。
   *
   * 之前这里是单例 `streaming` 布尔 + `[streaming]` 依赖的 effect：第二条流
   * 的 `setStreaming(true)` 在已经是 true 时被 React 丢弃，effect 不重跑，
   * fetch 根本没发出——用户表现为「后面新建的会话没进列表，丢了」。
   */
  const runsRef = useRef(new Map<string, StreamRun>());
  const runSeqRef = useRef(0);
  const [runKeys, setRunKeys] = useState<string[]>([]);
  /** 尚未拿到服务端 id 的新会话流：它拥有当前空视图，离开即失去归属。 */
  const draftRunKeyRef = useRef<string | null>(null);
  const syncRuns = () => setRunKeys([...runsRef.current.keys()]);

  // 当前视图归属：activeConv 非空时看它；为空时看持有这个空视图的草稿流。
  const [viewKey, setViewKey] = useState<string | null>(null);
  const viewKeyRef = useRef<string | null>(null);
  const [viewOwnsStream, setViewOwnsStream] = useState(false);
  useEffect(() => { viewKeyRef.current = viewKey; }, [viewKey]);
  // 仅当“正在查看的会话”正是流式输出所属会话时，编辑器才进入流式态。
  // 停留在别的会话时，输入框保持可用，便于直接继续提问。
  const viewingStream = viewOwnsStream && runKeys.includes(viewKey ?? '');
  const allSel = selected.length === visibleKbs.length;
  const scopeLabel = allSel ? '我可见的全部' : (selected.length === 0 ? '未选择任何库' : `已选 ${selected.length} 库`);

  // Preserve an explicit scope across refreshes; changed IDs matter even when
  // the number of visible libraries stays the same.
  const previousKbIds = useRef<string[]>([]);
  useEffect(() => {
    const ids = visibleKbs.map(kb => kb.id);
    const previous = previousKbIds.current;
    previousKbIds.current = ids;
    setSelected(current => {
      const wasAll = current.length === previous.length && previous.every(id => current.includes(id));
      const next = wasAll ? ids : current.filter(id => ids.includes(id));
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [visibleKbs]);

  useEffect(() => {
    const refresh = () => {
      setConversationList([...appStore.CONVERSATIONS]);
      setConvMore(appStore.CONVERSATIONS_META?.hasMore ?? false);
      setConvCursor(appStore.CONVERSATIONS_META?.nextCursor ?? null);
    };
    window.addEventListener('app-admin-data-updated', refresh);
    return () => window.removeEventListener('app-admin-data-updated', refresh);
  }, []);

  useEffect(() => {
    const onNew = () => { newChat(); };
    window.addEventListener('app-new-chat', onNew);
    return () => window.removeEventListener('app-new-chat', onNew);
  }, []);

  /**
   * 启动一条流。返回它在注册表中的键：已有会话用会话 id，新会话用临时键
   * `draft:<n>`，收到 `conversation` 事件后重键为真实 id。
   *
   * 所有写入都以「当前视图是否归属本流」为前提，因此并发的多条流互不干扰：
   * 用户在 A 生成时切到 B 提问，两条流各自更新自己的会话列表项与消息。
   */
  const startRun = useCallback((opts: {
    convId: string | null;
    text: string;
    kbScope: string[];
  }) => {
    const seq = ++runSeqRef.current;
    const controller = new AbortController();
    let convId = opts.convId;
    let currentKey = opts.convId ?? '';
    let active = true;
    let accumulatedText = "";
    let streamError = "";
    let streamFinished = false;
    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const accumulatedTextRef = { current: "" };

    // 本流是否仍拥有当前视图。新会话在拿到 id 前由草稿键代表当前空视图。
    const ownsView = () => runOwnsView(viewKeyRef.current, draftRunKeyRef.current, convId, currentKey);

    const updateAssistant = (text: string, done: boolean) => {
      if (!active || !ownsView()) return;
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

    // 流式渲染缓冲：SSE 每个 delta 直接 setState 会让长回答以每 token 一次
    // 全列表重渲染（叠加 O(n²) 的答案重解析）。以 ~50ms 合并刷新， citation/
    // trace/done 等结构化事件到达时立即冲刷，保证顺序与最终一致性。
    const flushAssistant = (done = false) => {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      updateAssistant(accumulatedTextRef.current, done);
    };
    const scheduleAssistantFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => { flushTimer = null; updateAssistant(accumulatedTextRef.current, false); }, 50);
    };

    const run: StreamRun = { convId, controller, flush: flushAssistant, title: opts.text };
    const registered = registerRun(runsRef.current, seq, run);
    currentKey = registered.key;
    if (registered.draft) draftRunKeyRef.current = currentKey;
    syncRuns();
    setViewOwnsStream(true);

    // 重键：草稿流拿到真实 id 后，从注册表换键。
    const rekey = (assigned: string) => {
      if (!rekeyRun(runsRef.current, currentKey, assigned)) return;
      convId = assigned;
      currentKey = assigned;
      syncRuns();
    };

    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ message: opts.text, kb_scope: opts.kbScope, conversation_id: convId || undefined }),
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

        const consumeLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const payload = trimmed.slice(6).trim();
          if (!payload || payload === '[DONE]') return;
          const data = JSON.parse(payload);
          if (data.type === 'delta') {
            accumulatedText += String(data.content || '');
            accumulatedTextRef.current = accumulatedText;
            scheduleAssistantFlush();
          } else if (data.type === 'replace') {
            // The grounding gate runs after sentences are streamed and can drop
            // or reinsert them. The server sends the authoritative post-gate text
            // as `replace`; replacing (not appending) keeps section order and
            // completeness identical to the stored message.
            accumulatedText = String(data.content || '');
            accumulatedTextRef.current = accumulatedText;
            flushAssistant(false);
          } else if (data.type === 'stage') {
            // 真实阶段进度（retrieving → reranking → generating → verifying）
            if (!ownsView()) return;
            const STAGE_LABELS: Record<string, string> = {
              retrieving: '检索证据', reranking: '重排验证', generating: '生成回答', verifying: '证据核验',
            };
            setStageLabel(STAGE_LABELS[data.stage] || data.detail || null);
          } else if (data.type === 'error') {
            streamError = String(data.content || '问答服务返回错误');
            if (!accumulatedText && ownsView()) { accumulatedTextRef.current = streamError; flushAssistant(false); }
          } else if (data.type === 'conversation') {
            flushAssistant(false);
            const assigned = String(data.conversation_id);
            // 视图可能仍停在本流的草稿键上：移交归属，别让 ownsView 失效。
            if (draftRunKeyRef.current === currentKey) draftRunKeyRef.current = assigned;
            if (viewKeyRef.current === currentKey) { setViewKey(assigned); viewKeyRef.current = assigned; }
            if (ownsView()) setActiveConv(assigned);
            rekey(assigned);
            setConversationList(list => [{ id: assigned, title: opts.text.slice(0, 120), createdAt: new Date().toISOString() }, ...list.filter(item => item.id !== assigned)]);
          } else if (data.type === 'citation') {
            flushAssistant(false);
            if (!ownsView()) return;
            const citation = { id: `${data.index}-${data.topic_slug}`, citationIndex: Number(data.index), title: data.timeline_entry?.doc_title || data.topic_slug || '知识主题', kb: data.timeline_entry?.source_kb, documentId: data.timeline_entry?.document_id, kbName: data.timeline_entry?.kb_name || data.timeline_entry?.source_kb || '知识库', truth: '—', evidences: 1, lastUpdate: '刚刚', snippet: data.timeline_entry?.snippet || '', path: data.topic_slug, pageNo: data.timeline_entry?.page_no, bbox: data.timeline_entry?.bbox };
            setCitations(items => [...items, citation]);
            setMessages(items => {
              const next = [...items];
              const lastIndex = next.map(item => item.role).lastIndexOf('ai');
              if (lastIndex >= 0) next[lastIndex] = { ...next[lastIndex], sources: [...(next[lastIndex].sources || []), citation] };
              return next;
            });
          } else if (data.type === 'trace' && data.node?.id) {
            flushAssistant(false);
            if (!ownsView()) return;
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
            if (typeof data.message_id === 'string' && ownsView()) {
              setMessages(items => items.map((item, index) => index === items.length - 1 && item.role === 'ai' ? { ...item, id: data.message_id } : item));
            }
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
        accumulatedTextRef.current = accumulatedText || streamError;
        if (ownsView()) flushAssistant(true);
        if (ownsView()) setStageLabel(null);
        // 用户中途切走又切回来的会话：这一轮答案从未在浏览器渲染过，
        // 生成结束后补拉一次已落库的消息，让视图回到完整状态。
        const resumeId = convId;
        if (resumeId && !ownsView() && viewKeyRef.current === resumeId) {
          void (async () => {
            try {
              const res = await fetch(`${API_BASE_URL}/api/v1/conversations/${resumeId}`, { headers: apiHeaders() });
              if (!res.ok) return;
              const conv = (await res.json()) as ConversationPayload;
              if (viewKeyRef.current !== resumeId) return;
              startTransition(() => {
                setMessages(mapConversationMessages(conv));
                setCitations(collectConversationCitations(conv));
              });
            } catch { /* 生成尚未落库：保持当前视图，不打断用户 */ }
          })();
        }
      } catch (err) {
        const isAbort = errorMessage(err) === 'AbortError' || (err as { name?: string })?.name === 'AbortError';
        if (isAbort) {
          // 用户主动停止：保留已生成的部分文本并标记完成。
          if (ownsView()) flushAssistant(true);
        } else if (active) {
          if (ownsView()) {
            accumulatedTextRef.current = "大模型请求失败：" + (errorMessage(err) || '未知错误');
            flushAssistant(true);
            setStageLabel(null);
          }
        }
      } finally {
        active = false;
        if (flushTimer !== null) clearTimeout(flushTimer);
        // 只摘除本流；其余并发流不受影响（单例版本在这里会误清空全部状态）。
        unregisterRun(runsRef.current, currentKey, run);
        if (draftRunKeyRef.current === currentKey) draftRunKeyRef.current = null;
        syncRuns();
        if (ownsView()) setViewOwnsStream(false);
      }
    })();
    return registered.key;
  }, []);

  // 流式期间自动滚底（除非用户主动上滑）
  useEffect(()=>{
    if (!autoStick) return;
    const el = scrollRef.current;
    if(el) el.scrollTop = el.scrollHeight;
  },[messages, autoStick]);

  // 卸载时中止所有仍在跑的流：并发之后不再有单例 effect 的 cleanup 兜底。
  useEffect(() => () => {
    for (const run of runsRef.current.values()) run.controller.abort();
    runsRef.current.clear();
  }, []);

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
    // 只停止当前会话自己的生成：切到别的会话时，停止按钮根本不出现，
    // 也不应能中止那边仍在进行的回答。
    if (!viewingStream || viewKey === null) return;
    // Complete the visible answer before aborting so partial text is kept.
    runsRef.current.get(viewKey)?.flush(true);
    runsRef.current.get(viewKey)?.controller.abort();
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoStick(true);
  };

  const send = (preset?: string)=>{
    const text = (preset ?? input).trim();
    if(!text || viewingStream || selected.length===0) return;
    // 同一会话已有回答在生成时不重复提交；其他会话的并发流互不影响。
    setMessages(ms=>[...ms, {role:'user', text}, {role:'ai', text:'', done:false, trace:[]}]);
    setInput('');
    setActiveCite(null);
    setCitations([]);
    setAutoStick(true);
    if(taRef.current) taRef.current.style.height = 'auto';
    startRun({ convId: activeConv, text, kbScope: selected });
  };

  const newChat = ()=>{
    ++openSeqRef.current;
    setConvLoading(false);
    // 只清空视图，不中止正在生成的答案：那些流仍留在注册表里按会话 id 继续跑，
    // 用户从列表切回该会话时会接着看到流式内容。新草稿流接管空视图。
    setMessages([]); setActiveCite(null); setCitations([]); setActiveConv(null);
    viewKeyRef.current = null; setViewKey(null); setViewOwnsStream(false); setStageLabel(null);
    setInput('');
    if(taRef.current){ taRef.current.style.height = 'auto'; taRef.current.focus(); }
  };

  const copyAnswer = useCallback(async (text: string) => { try { await navigator.clipboard.writeText(text); window.dispatchEvent(new CustomEvent('app-toast',{detail:'回答已复制'})); } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'复制失败，请检查浏览器权限'})); } }, []);
  const saveFeedback = useCallback(async (feedback: string, messageId?: string) => {
    if (!activeConv) return;
    let targetId = messageId || '';
    try {
      // 历史消息自带 id，直接反馈；旧数据缺 id 时才回退拉取整段会话找末条回答。
      if (!targetId) {
        const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}` ,{headers:apiHeaders()});
        if (!response.ok) throw new Error('会话加载失败，反馈未提交');
        const conversation = await response.json();
        targetId = [...(conversation.messages || [])].reverse().find(item=>item.role==='assistant')?.id || '';
      }
      if (!targetId) throw new Error('未找到回答，反馈未提交');
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${activeConv}/messages/${targetId}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({feedback})});
      if (!response.ok) throw new Error('反馈提交失败，请重试');
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'反馈已记录'}));
    } catch (error) {
      emitToast(errorMessage(error) || '反馈提交失败，请重试');
    }
  }, [activeConv]);

  const previewCitation = useCallback((citation: Citation) => {
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
  }, []);

  const handleAnswerCitation = useCallback((source: Citation, index: number) => {
    setActiveCite(index);
    previewCitation(source);
  }, [previewCitation]);

  const openConversation = useCallback(async (id: string) => {
    if (!id) return;
    // 连续点击不同会话时只应用最后一次响应，避免慢响应覆盖新选择。
    const seq = ++openSeqRef.current;
    setConvLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}`, { headers: apiHeaders() });
      if (!response.ok) throw new Error('会话加载失败');
      const conversation = await response.json();
      if (seq !== openSeqRef.current) return;
      const mapped = mapConversationMessages(conversation);
      const allCitations = collectConversationCitations(conversation);
      startTransition(() => {
        setActiveConv(id);
        viewKeyRef.current = id; setViewKey(id);
        setViewOwnsStream(runsRef.current.has(id));
        setMessages(mapped);
        setCitations(allCitations);
      });
      // 切回仍在生成的会话：浏览器离开期间没收到 delta，磁盘上这一轮要等
      // 生成结束才落库。标记为待补拉，由流结束回调统一重载（见下），
      // 而不是在这里定时轮询 —— 固定延迟在快慢两种机器上都会猜错。
      if (runsRef.current.has(id)) setViewOwnsStream(true);
    } catch (error) {
      if (seq === openSeqRef.current) window.dispatchEvent(new CustomEvent('app-toast', {detail: errorMessage(error) || '会话加载失败'}));
    } finally {
      if (seq === openSeqRef.current) setConvLoading(false);
    }
  }, []);

  // 命令面板跨屏打开会话：订阅最新的 openConversation，保证流式期间守卫生效。
  useEffect(() => {
    const onOpen = (e: Event) => { const detail = (e as CustomEvent<string>).detail; if (detail) void openConversation(detail); };
    window.addEventListener('app-open-conversation', onOpen);
    return () => window.removeEventListener('app-open-conversation', onOpen);
  }, [openConversation]);

  const hideConversation = (conv: ConversationSummary) => {
    const id = conv?.id;
    if (!id) return;
    const next = new Set(hiddenConvs); next.add(id); setHiddenConvs(next);
    if (activeConv === id) { setMessages([]); setActiveConv(null); setCitations([]); viewKeyRef.current = null; setViewKey(null); setViewOwnsStream(false); setStageLabel(null); }
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

  const answerDone = messages.length>0 && messages[messages.length-1].done;

  // 会话分组按列表/搜索/隐藏集合记忆化：输入框打字等高频重渲染不再
  // 重复做 O(n) 的日期分组过滤。
  const convGroups = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const visibleList = conversationList.filter((c) => !hiddenConvs.has(c.id));
    const filtered = q ? visibleList.filter((c) => (c.title || '').toLowerCase().includes(q)) : visibleList;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();
    const sevenDaysAgoMs = startOfTodayMs - 6 * 24 * 3600 * 1000;
    const thirtyDaysAgoMs = startOfTodayMs - 29 * 24 * 3600 * 1000;
    const ts = (c: ConversationSummary) => (c.createdAt ? new Date(c.createdAt).getTime() : NaN);
    return [
      { label: '今天', items: filtered.filter((c) => { const t = ts(c); return Number.isFinite(t) && t >= startOfTodayMs; }) },
      { label: '昨天', items: filtered.filter((c) => { const t = ts(c); return Number.isFinite(t) && t < startOfTodayMs && t >= startOfTodayMs - 86400000; }) },
      { label: '近 7 天', items: filtered.filter((c) => { const t = ts(c); return Number.isFinite(t) && t < startOfTodayMs - 86400000 && t >= sevenDaysAgoMs; }) },
      { label: '30 天内', items: filtered.filter((c) => { const t = ts(c); return Number.isFinite(t) && t < sevenDaysAgoMs && t >= thirtyDaysAgoMs; }) },
      { label: '更早', items: filtered.filter((c) => { const t = ts(c); return Number.isFinite(t) && t < thirtyDaysAgoMs; }) },
      { label: '未分类', items: filtered.filter((c) => !Number.isFinite(ts(c))) },
    ].filter((g) => g.items.length > 0);
  }, [conversationList, convSearch, hiddenConvs]);

  // “重写”取最近一条提问；messages 每次流式刷新都会变，这里按值记忆化
  // 保证传给消息组件的 prop 引用稳定。
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].text;
    }
    return undefined;
  }, [messages]);
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  const resend = useCallback((question?: string) => { sendRef.current(question); }, []);

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
          {convGroups.length === 0 ? (
            <div className="conv-empty">{convSearch.trim() ? '没有匹配的会话' : '暂无会话'}</div>
          ) : convGroups.map((g) => {
            const hasActive = g.items.some((c) => c.id === activeConv);
            const q = convSearch.trim();
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
          })}
          {convMore && !convSearch.trim() && (
            <button type="button" className="conv-more" onClick={loadMoreConversations} disabled={convMoreLoading}>
              {convMoreLoading ? '加载中…' : '加载更早的会话'}
            </button>
          )}
        </div>
        <div className="new-chat" onClick={()=>{ newChat(); setConvOpen(false); }} title="开始一段新对话 (⌘N)">
          <Icon name="plus" size={12}/> 新建会话
        </div>
      </div>

      <div className="chat-main">
        {convLoading && (
          <div style={{ position: 'absolute', top: 12, right: 20, zIndex: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 14, background: 'var(--bg-2, rgba(0,0,0,0.05))', color: 'var(--ink-3, #666)', fontSize: 12 }}>
            <span className="streaming-dot" aria-hidden="true" />
            会话加载中…
          </div>
        )}
        {viewingStream && stageLabel && (
          <div style={{ position: 'absolute', top: convLoading ? 48 : 12, right: 20, zIndex: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 14, background: 'var(--bg-2, rgba(0,0,0,0.05))', color: 'var(--ink-3, #666)', fontSize: 12 }} aria-live="polite">
            <span className="streaming-dot" aria-hidden="true" />
            {stageLabel}…
          </div>
        )}
        <div className="conv-mobile-bar">
          <button type="button" className="chat-mobile-conv-btn" onClick={() => setConvOpen(true)}>
            <Icon name="chat" size={13}/>
            <span>会话列表 ({conversationList.length}{convMore ? '+' : ''})</span>
          </button>
        </div>
        <div className="chat-scroll" ref={scrollRef}>
          {!autoStick && messages.length > 0 && (
            <button type="button" className="scroll-to-bottom" onClick={scrollToBottom} title="回到底部">
              <span>↓ 回到底部</span>
              {viewingStream && <span className="streaming-dot" />}
            </button>
          )}
          <div className="chat-inner">
            {messages.length===0 && (
              <div className="welcome">
                <div className="welcome-icon" aria-hidden="true">百</div>
                <h1>问你的大脑。<em>答案可溯源。</em></h1>
                <p className="welcome-lead">基于你所在组织的知识库，提供准确、可靠、可追溯的答案。无论是文档、流程、数据还是项目经验，都会先经后台编译整理（Compiled Truth + Timeline 证据链），每条引用都能回溯原始文档。</p>
                <div className="suggest">
                  {[
                    { icon: 'doc', q: '数据出境安全评估的新规对申报材料有什么要求？' },
                    { icon: 'spark', q: '研发中心的 AI 平台架构是怎样的？' },
                    { icon: 'users', q: '我之前参与过哪些出境评估项目？' },
                    { icon: 'model', q: 'Casbin 模型如何支持三级知识库？' },
                  ].map((s,i)=>(
                    <button key={i} className="suggest-card" onClick={()=>send(s.q)}>
                      <span className="sc-ic"><Icon name={s.icon} size={16}/></span>
                      <span className="sc-q">{s.q}</span>
                      <Icon name="chevron" size={13} className="sc-arrow"/>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, mi) => (
              <MessageItem
                key={mi}
                msg={msg}
                scopeLabel={scopeLabel}
                allSel={allSel}
                selectedCount={selected.length}
                activeCitation={activeCite}
                conversationId={activeConv}
                lastUserText={lastUserText}
                onCitation={handleAnswerCitation}
                onPreview={previewCitation}
                onCopy={copyAnswer}
                onResend={resend}
                onFeedback={saveFeedback}
              />
            ))}

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
                {viewingStream ? (
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

interface MessageItemProps {
  msg: ChatMessage;
  scopeLabel: string;
  allSel: boolean;
  selectedCount: number;
  activeCitation: number | null;
  /** 该消息所属会话：调用链明细按需拉取时要用 */
  conversationId?: string | null;
  lastUserText?: string;
  onCitation: (source: Citation, index: number) => void;
  onPreview: (citation: Citation) => void;
  onCopy: (text: string) => void;
  onResend: (question?: string) => void;
  onFeedback: (feedback: string, messageId?: string) => void;
}

/**
 * 单条消息 memo 化：会话切换/流式刷新/输入打字时只有内容变化的消息
 * 重渲染，历史消息的 AnswerMarkdown（marked 解析）不再反复重建。
 */
const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (props.msg.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble">{props.msg.text}</div>
      </div>
    );
  }
  return <AiMessageBody {...props} />;
});

const AiMessageBody = memo(function AiMessageBody({
  msg, scopeLabel, allSel, selectedCount, activeCitation, conversationId, lastUserText,
  onCitation, onPreview, onCopy, onResend, onFeedback,
}: MessageItemProps) {
  const traceNodes = useMemo(() => (Array.isArray(msg.trace) ? (msg.trace as TraceNode[]) : []), [msg.trace]);
  const traceStats = useMemo(() => {
    const started = traceNodes.map((node) => Date.parse(node.startedAt || '')).filter(Number.isFinite);
    const finished = traceNodes.map((node) => Date.parse(node.finishedAt || '')).filter(Number.isFinite);
    return {
      total: traceNodes.length,
      success: traceNodes.filter((node) => node.status === 'success' || node.status === 'skipped').length,
      warnings: traceNodes.filter((node) => node.status === 'warning').length,
      failed: traceNodes.filter((node) => node.status === 'failed').length,
      running: traceNodes.filter((node) => node.status === 'running').length,
      duration: started.length && finished.length
        ? Math.max(0, Math.max(...finished) - Math.min(...started))
        : null,
    };
  }, [traceNodes]);

  return (
    <div className="msg msg-ai">
      <div className="body">
        <div className="who">
          <span className="dot"/>
          <span>百纳 · 大脑综述</span>
          <span style={{color:'var(--ink-4)'}}>· 你的大脑 · {scopeLabel}{allSel ? `（${selectedCount} 库）` : ''}</span>
        </div>
        {/* 流式生成期间展示动态管线进度 */}
        {!msg.done && traceNodes.length > 0 && <PipelineProgress nodes={traceNodes} />}
        <AnswerMarkdown content={msg.text} sources={msg.sources} activeCitation={activeCitation} streaming={!msg.done} onCitation={onCitation} />
        {msg.done && (msg.sources?.length ?? 0) > 0 && (
          <div className="answer-sources"><span>来源：</span>{(msg.sources || []).map((source: Citation, index: number) => <button key={source.id || index} onClick={()=>onPreview(source)} title="打开原始文档预览">[{source.citationIndex || index + 1}] {source.title}</button>)}</div>
        )}
        {/* 历史消息不再随会话列表下发 trace（单条可达百 KB），折叠时按需拉取 */}
        {msg.done && msg.id && conversationId
          ? <TraceDetails nodes={traceNodes} stats={traceStats} conversationId={conversationId} messageId={msg.id} />
          : traceNodes.length > 0 && <TraceDetails nodes={traceNodes} stats={traceStats} />}
        {msg.done && (
          <div className="actions">
            <button onClick={()=>onCopy(msg.text)}><Icon name="copy" size={12}/> 复制</button>
            <button onClick={()=>onResend(lastUserText)}><Icon name="refresh" size={12}/> 重写</button>
            <button style={{marginLeft:'auto'}} onClick={()=>onFeedback('useful', msg.id)}><Icon name="check" size={12}/> 有用</button>
          </div>
        )}
      </div>
    </div>
  );
});

const PIPELINE_STAGES: [string, string][] = [
  ['query_rewrite', '意图分析'],
  ['gbrain_retrieval', '知识检索'],
  ['confidence_rerank', '证据重排'],
  ['grounding_gate', '事实校验'],
  ['llm_generation', '生成回答'],
  ['citation_validation', '引用校验'],
];

function PipelineProgress({ nodes }: { nodes: TraceNode[] }) {
  const activeIds = new Set(nodes.map((n) => n.id));
  const doneIds = new Set(nodes.filter((n) => n.status === 'success' || n.status === 'skipped').map((n) => n.id));
  const runningIds = new Set(nodes.filter((n) => n.status === 'running').map((n) => n.id));
  return (
    <div className="pipeline-progress" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 0 4px', fontSize: 12, lineHeight: 1 }}>
      {PIPELINE_STAGES.map(([id, label]) => {
        const done = doneIds.has(id);
        const running = runningIds.has(id);
        const pending = !activeIds.has(id);
        return (
          <span
            key={id}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', borderRadius: 12,
              background: done ? 'var(--evidence-bg, #e8f5e9)' : running ? 'var(--accent-bg, #e3f2fd)' : 'var(--bg-2, #f5f5f5)',
              color: done ? 'var(--evidence, #2e7d32)' : running ? 'var(--accent, #1565c0)' : 'var(--ink-4, #999)',
              fontWeight: running ? 600 : 400,
              transition: 'all 0.3s ease',
            }}
          >
            {done ? '✓' : running ? '◉' : pending ? '○' : '○'}
            {' '}{label}
            {running && <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: 'currentColor', animation: 'pulse 1s infinite' }} />}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 调用链明细懒渲染：折叠状态只渲染摘要（计数/耗时），展开时才把每个
 * 节点的 details JSON 序列化进 DOM——长会话切换不再为每条消息的历史
 * trace 做全量 stringify。
 */
const TraceDetails = memo(function TraceDetails({ nodes, stats, conversationId, messageId }: { nodes: TraceNode[]; stats: { total: number; success: number; warnings: number; failed: number; running: number; duration: number | null }; conversationId?: string; messageId?: string }) {
  const [open, setOpen] = useState(false);
  // 会话列表不再随每条消息下发 processingTrace（单条可达百 KB）。首次展开时
  // 拉取一次，之后用组件内缓存；summary 只在未加载时显示"点击展开"。
  const [lazyNodes, setLazyNodes] = useState<TraceNode[] | null>(null);
  const [lazyLoading, setLazyLoading] = useState(false);
  // 首次展开时按需拉取：会话列表不再随每条消息下发 processingTrace（单条可达
  // 百 KB）。从 toggle 事件发起而不是 effect，避免 effect 内的级联 setState。
  const loadLazyTrace = useCallback(() => {
    if (lazyNodes !== null || lazyLoading || !conversationId || !messageId) return;
    setLazyLoading(true);
    void (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/conversations/${conversationId}/messages/${messageId}/trace`, { headers: apiHeaders() });
        if (!res.ok) { setLazyNodes([]); return; }
        const data = (await res.json()) as { trace?: unknown };
        setLazyNodes(Array.isArray(data?.trace) ? (data.trace as TraceNode[]) : []);
      } catch { /* 调用链是诊断信息，拉取失败不打扰用户 */ }
      finally { setLazyLoading(false); }
    })();
  }, [conversationId, messageId, lazyNodes, lazyLoading]);
  const onToggle = useCallback((e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = (e.target as HTMLDetailsElement).open;
    setOpen(next);
    if (next) loadLazyTrace();
  }, [loadLazyTrace]);
  const displayNodes = nodes.length > 0 ? nodes : (lazyNodes ?? []);
  const displayStats = nodes.length > 0 || lazyNodes !== null
    ? stats
    : { total: 0, success: 0, warnings: 0, failed: 0, running: 0, duration: null };
  return (
    <details className="retrieval" onToggle={onToggle}>
      <summary>
        <Icon name="spark" size={12} color="var(--evidence)"/>
        <span>本次响应处理调用链 ·</span>
        {lazyNodes === null && nodes.length === 0
          ? <b>{lazyLoading ? '加载中…' : '展开查看'}</b>
          : <b>{displayStats.failed ? `${displayStats.failed} 个异常` : displayStats.running ? `${displayStats.running} 个执行中` : `${displayStats.success}/${displayStats.total} 个节点正常`}</b>}
        {displayStats.warnings > 0 && <span className="trace-summary-warning">· {displayStats.warnings} 个警告</span>}
        {displayStats.duration !== null && <span className="trace-total">{displayStats.duration}ms</span>}
        <span className="trace-expand">展开 ▾</span>
      </summary>
      {open && (
        <div className="retrieval-body">
          {displayNodes.length === 0 && <div className="ret-step">暂无调用链记录</div>}
          {displayNodes.map((node: TraceNode, index: number) => (
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
      )}
    </details>
  );
});
