"use client";
import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import dynamic from 'next/dynamic';
import { Icon } from '@/components/common/Icon';
import { TYPE_BADGE } from '@/components/common/TypeBadge';
import { ScopePicker } from '@/components/common/ScopePicker';
import { ContextMenu } from '@/components/common/ContextMenu';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage } from '@/lib/errors';
import {
  applyPoll, isTerminal, labelForRun, pollDelayFor, runningConversationIds, STAGE_LABELS,
  type RunPollResult, type RunStage, type RunState,
} from '@/lib/stream-registry';
import { observeAnswerVisibility } from '@/lib/render-timing';
import { emitToast } from '@/lib/app-events';
const AnswerMarkdown = dynamic(() => import('./AnswerMarkdown').then(module => module.AnswerMarkdown), {
  loading: () => <span role="status">正在加载回答…</span>,
});
import type {
  ChatMessage, Citation, ConversationSummary, CtxMenuItem, PreviewTarget, TraceNode,
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
interface ConversationPayload { messages?: ConversationMessagePayload[]; hasMore?: boolean; nextCursor?: string | null; activeRun?: RunState | null }

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

/** Run payloads carry the same citation shape the SSE stream used to send. */
function collectRunCitations(run: RunPollResult): Citation[] {
  const list = Array.isArray(run.citations) ? run.citations as ConversationCitationPayload[] : [];
  return list.map((entry, index) => mapCitation(entry, run.messageId, index));
}

interface TraceStats { total: number; success: number; warnings: number; failed: number; running: number; duration: number | null }

/**
 * Summarise a set of trace nodes.
 *
 * This has to run over the nodes actually on screen. The summary bar used to
 * read the parent's stats, which were computed from the message's own trace —
 * empty for any message loaded from history, since the conversation endpoint
 * strips processingTrace. After the lazy fetch filled the list the bar kept
 * showing the empty numbers: every history message read "0/0 个节点正常".
 */
function summarizeTrace(traceNodes: TraceNode[]): TraceStats {
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
}

function collectConversationCitations(conversation: ConversationPayload): Citation[] {
  return (conversation.messages || []).flatMap((message) =>
    Array.isArray(message.citationsSummary)
      ? message.citationsSummary.map((cite, index) => mapCitation(cite, message.id, index))
      : [],
  );
}

const ConversationRow = memo(function ConversationRow({ conversation, active, runLabel, onOpen, onMenu }: {
  conversation: ConversationSummary; active: boolean; runLabel?: string;
  onOpen: (id: string) => void; onMenu: (event: React.MouseEvent, conversation: ConversationSummary) => void;
}) {
  return <div className={`conv-item ${active ? 'active' : ''} ${runLabel ? 'running' : ''}`}
    role="button" tabIndex={0} onClick={() => onOpen(conversation.id)}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(conversation.id); } }}
    onContextMenu={event => onMenu(event, conversation)}>
    <span className="conv-title">{conversation.title || '未命名会话'}</span>
    {runLabel && <span className="conv-run" title={`正在生成回答：${runLabel}`}>
      <span className="spinner" aria-hidden="true" /><span className="conv-run-label">{runLabel}</span>
    </span>}
    <span className="conv-time">{conversation.createdAt ? new Date(conversation.createdAt).toLocaleDateString('zh-CN') : ''}</span>
  </div>;
});

export function ChatScreen(){
  const visibleKbs = appStore.KNOWLEDGE_BASES;
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);   // {role:'user'|'ai', text, done}
  // 每条流各持一份控制器与收尾函数，按会话 id（或草稿键）索引，可并发。
  // 单例版本只能容纳一条流：第二条流的启动信号与第一条相同，被 React 丢弃。
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<ConversationSummary[]>(appStore.CONVERSATIONS);
  const [convOpen, setConvOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  // 侧栏只加载首页（30 条），更早的会话按需翻页。
  const [convMore, setConvMore] = useState(() => appStore.CONVERSATIONS_META?.hasMore ?? false);
  const [convCursor, setConvCursor] = useState<string | null>(() => appStore.CONVERSATIONS_META?.nextCursor ?? null);
  const convPaginationAdvancedRef = useRef(false);
  const [convMoreLoading, setConvMoreLoading] = useState(false);
  const loadMoreConversations = useCallback(async () => {
    if (convMoreLoading || !convMore || !convCursor) return;
    setConvMoreLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/conversations?paginated=1&limit=30&before=${encodeURIComponent(convCursor)}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error('会话列表加载失败');
      const page = (await res.json()) as { items?: ConversationSummary[]; nextCursor?: string | null; hasMore?: boolean };
      const items = Array.isArray(page?.items) ? page.items : [];
      setConversationList(prev => {
        const seen = new Set(prev.map(c => c.id));
        return [...prev, ...items.filter(c => !seen.has(c.id))];
      });
      convPaginationAdvancedRef.current = true;
      setConvMore(page?.hasMore === true);
      setConvCursor(typeof page?.nextCursor === 'string' ? page.nextCursor : null);
    } catch (error) { emitToast(errorMessage(error, '会话列表加载失败')); } finally { setConvMoreLoading(false); }
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
  const [historyMore, setHistoryMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyControllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef('');
  const draftsRef = useRef(new Map<string, string>());
  const [citeCollapsed, setCiteCollapsed] = useState(true);
  const [autoStick, setAutoStick] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [hiddenConvs, setHiddenConvs] = useState<Set<string>>(() => new Set<string>());
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openSeqRef = useRef(0);
  /**
   * 每个会话一条独立的问答运行，按会话 id 登记。新会话在服务端分配 id 前，
   * 先用客户端序号做临时键，拿到 conversationId 后并入。
   *
   * 之前这里是单例 `streaming` 布尔 + `[streaming]` 依赖的 effect：第二条流
   * 的 `setStreaming(true)` 在已经是 true 时被 React 丢弃，effect 不重跑，
   * fetch 根本没发出——用户表现为「后面新建的会话没进列表，丢了」。
   */
  const runsRef = useRef(new Map<string, RunState>());
  const runSeqRef = useRef(0);
  const [runs, setRuns] = useState(new Map<string, RunState>());
  const runningIds = useMemo(() => runningConversationIds(runs), [runs]);
  const syncRuns = useCallback(() => setRuns(new Map(runsRef.current)), []);
  /** Pollers to tear down on unmount / logout. */
  const pollersRef = useRef(new Map<string, () => void>());
  /** Runs that completed while another conversation was on screen. */
  const renderMeasurementsRef = useRef(new Map<string, { startedAt: number; messageId?: string; firstVisibleMs?: number; recorded?: boolean }>());
  const pendingAnswersRef = useRef(new Map<string, Pick<RunPollResult, 'runId' | 'messageId' | 'status'>>());

  // 当前视图归属：activeConv 非空时看它；为空时看持有这个空视图的草稿流。
  const [viewKey, setViewKey] = useState<string | null>(null);
  const viewKeyRef = useRef<string | null>(null);

  // 仅当“正在查看的会话”仍在生成回答时，输入框才进入生成态。
  // 停留在别的会话时，输入框保持可用，便于直接继续提问。
  const viewingStream = viewKey !== null && runningIds.includes(viewKey);
  // Stage text is derived from the registry rather than stored once: a single
  // value belonged to whichever conversation the user last looked at, so
  // switching away dropped the progress indicator of the conversation that was
  // still generating (production: the stage nodes vanished on navigate).
  // The raw stage key drives the pipeline chips; the label is what the status
  // pill shows. Passing only the label made every STAGE_TO_PIPELINE lookup miss.
  const viewRun = viewKey ? runs.get(viewKey) : undefined;
  const viewStage = viewRun?.status === 'running' ? viewRun.stage : null;
  const stageLabel = useMemo(() => labelForRun(viewRun), [viewRun]);
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

  const applyAnswer = useCallback((state: RunPollResult) => {
    const sources = state.status === 'completed' ? collectRunCitations(state) : [];
    const answer: ChatMessage = { role: 'ai', text: state.status === 'failed'
      ? state.errorMessage || '问答未成功完成。' : state.answer || '', done: true,
      id: state.messageId || `run-${state.runId}`, trace: [], sources };
    setMessages(current => {
      if (state.messageId && current.some(message => message.id === state.messageId)) return current;
      const last = current[current.length - 1];
      return last?.role === 'ai' && !last.done ? [...current.slice(0, -1), answer] : [...current, answer];
    });
    setCitations(sources);
  }, []);

  const pollRun = useCallback((run: RunState) => {
    if (!run.runId || pollersRef.current.has(run.conversationId)) return;
    const id = run.conversationId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const stop = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (pollersRef.current.get(id) === stop) pollersRef.current.delete(id);
      if (runsRef.current.get(id)?.runId === run.runId) runsRef.current.delete(id);
      syncRuns();
    };
    pollersRef.current.set(id, stop);
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        try {
          const response = await fetch(`${API_BASE_URL}/api/v1/chat/runs/${run.runId}`, { headers: apiHeaders() });
          if (!response.ok) {
            if (response.status === 401 || response.status === 403 || response.status === 404) {
              if (viewKeyRef.current === id) applyAnswer({ ...run, status: 'failed', errorMessage: '问答状态不可用，请重新打开会话。' });
              stop(); return;
            }
            throw new Error('暂时无法读取问答进度');
          }
          const state = await response.json() as RunPollResult;
          if (cancelled || runsRef.current.get(id)?.runId !== run.runId) return;
          failures = 0;
          runsRef.current = applyPoll(runsRef.current, id, state);
          syncRuns();
          if (!isTerminal(state.status)) {
            schedule(typeof document !== 'undefined' && document.hidden ? 8000 : pollDelayFor(state.stage));
            return;
          }
          const measurement = renderMeasurementsRef.current.get(id);
          if (measurement && state.status === 'completed') measurement.messageId = state.messageId;
          pendingAnswersRef.current.set(id, { runId: state.runId, messageId: state.messageId, status: state.status });
          if (viewKeyRef.current === id) applyAnswer(state);
          stop();
        } catch {
          if (!cancelled) { failures++; schedule(Math.min(30000, 2000 * 2 ** Math.min(failures, 4))); }
        }
      }, delay);
    };
    schedule(600);
  }, [applyAnswer, syncRuns]);

  const adoptRunStages = useCallback((items: ConversationSummary[]) => {
    let changed = false;
    for (const item of items) {
      if (typeof item.runStage !== 'string' || typeof item.runId !== 'string'
        || !item.runId || pendingAnswersRef.current.has(item.id) || runsRef.current.has(item.id)) continue;
      const run: RunState = { runId: item.runId, conversationId: item.id, status: 'running', stage: item.runStage as RunStage };
      runsRef.current.set(item.id, run);
      changed = true;
      pollRun(run);
    }
    if (changed) syncRuns();
  }, [pollRun, syncRuns]);

  useEffect(() => {
    const refresh = () => {
      setConversationList(current => {
        const incoming = [...appStore.CONVERSATIONS];
        const seen = new Set(incoming.map(item => item.id));
        return [...incoming, ...current.filter(item => !seen.has(item.id))];
      });
      adoptRunStages(appStore.CONVERSATIONS);
      if (!convPaginationAdvancedRef.current) {
        setConvMore(appStore.CONVERSATIONS_META?.hasMore ?? false);
        setConvCursor(appStore.CONVERSATIONS_META?.nextCursor ?? null);
      }

    };
    window.addEventListener('app-admin-data-updated', refresh);
    return () => window.removeEventListener('app-admin-data-updated', refresh);
  }, [adoptRunStages]);

  // Adopt once on mount: the bootstrap payload is already in appStore.
  useEffect(() => { adoptRunStages(conversationList); }, [conversationList, adoptRunStages]);


  /**
   * Ask a question. The server answers with a run id immediately and does the
   * work behind the request's back; we then poll for stage progress until the
   * run completes, at which point the whole answer arrives in that payload.
   *
   * Nothing here holds a stream open, so several conversations can be in flight
   * at once and switching away from one never disturbs it.
   */
  const startRun = useCallback((opts: { convId: string | null; text: string; kbScope: string[] }) => {
    const draftKey = opts.convId || `draft:${++runSeqRef.current}`;
    if (runsRef.current.has(draftKey)) return;
    renderMeasurementsRef.current.set(draftKey, { startedAt: performance.now() });
    const scope = [...opts.kbScope];
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      pollersRef.current.delete(draftKey);
      runsRef.current.delete(draftKey);
      syncRuns();
    };
    runsRef.current.set(draftKey, { runId: '', conversationId: draftKey, status: 'running', stage: 'queued' });
    pollersRef.current.set(draftKey, stop);
    if (opts.convId === null) { viewKeyRef.current = draftKey; setViewKey(draftKey); }
    syncRuns();
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...apiHeaders() },
          body: JSON.stringify({ message: opts.text, kb_scope: scope, conversation_id: opts.convId || undefined, stream: false }),
        });
        if (!response.ok) {
          let detail = `API Error (${response.status})`;
          try { const payload = await response.json(); detail = payload?.message || payload?.error || detail; } catch { /* keep status */ }
          throw new Error(detail);
        }
        const run = { ...await response.json(), status: 'running', stage: 'queued' } as RunState;
        if (!run.runId || !run.conversationId) throw new Error('问答运行信息不完整');
        if (cancelled) {
          void fetch(`${API_BASE_URL}/api/v1/chat/runs/${run.runId}/cancel`, { method: 'POST', headers: apiHeaders() });
          return;
        }
        const measurement = renderMeasurementsRef.current.get(draftKey);
        if (measurement) {
          renderMeasurementsRef.current.delete(draftKey);
          renderMeasurementsRef.current.set(run.conversationId, measurement);
        }
        const ownsView = viewKeyRef.current === draftKey;
        pollersRef.current.delete(draftKey);
        runsRef.current.delete(draftKey);
        pendingAnswersRef.current.delete(run.conversationId);
        runsRef.current.set(run.conversationId, run);
        setConversationList(list => list.some(item => item.id === run.conversationId) ? list
          : [{ id: run.conversationId, title: opts.text.slice(0, 120), createdAt: new Date().toISOString() }, ...list]);
        if (ownsView) {
          setActiveConv(run.conversationId);
          viewKeyRef.current = run.conversationId; setViewKey(run.conversationId);
        }
        syncRuns();
        pollRun(run);
      } catch (error) {
        if (cancelled) return;
        if (viewKeyRef.current === draftKey) applyAnswer({ runId: '', conversationId: draftKey, stage: 'queued', status: 'failed',
          errorMessage: `问答请求失败：${errorMessage(error) || '未知错误'}` });
        stop();
      }
    })();
  }, [applyAnswer, pollRun, syncRuns]);

  const recordVisibleAnswer = useCallback((conversationId: string, messageId: string, done: boolean, at: number) => {
    const measurement = renderMeasurementsRef.current.get(conversationId);
    if (!measurement || measurement.messageId !== messageId || measurement.recorded) return;
    const elapsed = Math.max(0, at - measurement.startedAt);
    measurement.firstVisibleMs ??= elapsed;
    if (!done) return;
    measurement.recorded = true;
    void fetch(`${API_BASE_URL}/api/v1/chat/messages/${messageId}/render-timing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...apiHeaders() },
      body: JSON.stringify({ firstVisibleMs: measurement.firstVisibleMs, finalVisibleMs: elapsed }),
    }).catch(() => undefined);
    renderMeasurementsRef.current.delete(conversationId);
  }, []);

  // 流式期间自动滚底（除非用户主动上滑）
  useEffect(()=>{
    if (!autoStick) return;
    const el = scrollRef.current;
    if(el) el.scrollTop = el.scrollHeight;
  },[messages, autoStick]);

  // 卸载时停掉所有轮询器：否则 detached 的定时器会继续写已卸载组件的状态。
  useEffect(() => () => {
    historyControllerRef.current?.abort();
    for (const stop of pollersRef.current.values()) stop();
    pollersRef.current.clear();
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
    const run = runsRef.current.get(viewKey);
    if (!run) return;
    // Stop polling first, then ask the server to abandon the run. The server
    // call is best-effort: only the instance that started the run can abort it.
    pollersRef.current.get(viewKey)?.();
    if (run.runId) void fetch(`${API_BASE_URL}/api/v1/chat/runs/${run.runId}/cancel`, { method: 'POST', headers: apiHeaders() })
      .catch(() => { /* the run's own deadline still bounds it */ });
    setMessages(ms => ms.map((m, i) => i === ms.length - 1 && m.role === 'ai' ? { ...m, text: m.text || '已停止生成。', done: true } : m));
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoStick(true);
  };

  const send = (preset?: string)=>{
    const text = (preset ?? input).trim();
    if(!text || convLoading || (viewKeyRef.current !== null && runsRef.current.has(viewKeyRef.current)) || selected.length===0) return;
    // 同一会话已有回答在生成时不重复提交；其他会话的并发流互不影响。
    setMessages(ms=>[...ms, {id: crypto.randomUUID(), role:'user', text}, {id: crypto.randomUUID(), role:'ai', text:'', done:false, trace:[]}]);
    inputRef.current = ''; if (viewKeyRef.current) draftsRef.current.delete(viewKeyRef.current); setInput('');
    setActiveCite(null);
    setCitations([]);
    setAutoStick(true);
    if(taRef.current) taRef.current.style.height = 'auto';
    startRun({ convId: activeConv, text, kbScope: selected });
  };

  const newChat = useCallback(()=>{
    ++openSeqRef.current;
    historyControllerRef.current?.abort();
    if (viewKeyRef.current) draftsRef.current.set(viewKeyRef.current, inputRef.current);
    inputRef.current = '';
    setConvLoading(false);
    setHistoryMore(false); setHistoryCursor(null);
    // 只清空视图，不中止正在生成的答案：那些流仍留在注册表里按会话 id 继续跑，
    // 用户从列表切回该会话时会接着看到流式内容。新草稿流接管空视图。
    setMessages([]); setActiveCite(null); setCitations([]); setActiveConv(null);
    viewKeyRef.current = null; setViewKey(null);
    setInput('');
    if(taRef.current){ taRef.current.style.height = 'auto'; taRef.current.focus(); }
  }, []);
  useEffect(() => {
    const onNew = () => { newChat(); };
    window.addEventListener('app-new-chat', onNew);
    return () => window.removeEventListener('app-new-chat', onNew);
  }, [newChat]);

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
    const seq = ++openSeqRef.current;
    historyControllerRef.current?.abort();
    const controller = new AbortController();
    historyControllerRef.current = controller;
    if (viewKeyRef.current) draftsRef.current.set(viewKeyRef.current, inputRef.current);
    viewKeyRef.current = id; setViewKey(id); setActiveConv(id);
    inputRef.current = draftsRef.current.get(id) || ''; setInput(inputRef.current);
    setMessages([]); setCitations([]); setActiveCite(null);
    setHistoryMore(false); setHistoryCursor(null); setHistoryLoading(false); setConvLoading(true); setAutoStick(true);
    setConvOpen(false);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}?limit=50`, { headers: apiHeaders(), signal: controller.signal });
      if (!response.ok) throw new Error('会话加载失败');
      let conversation = await response.json() as ConversationPayload;
      if (seq !== openSeqRef.current) return;
      const pending = pendingAnswersRef.current.get(id);
      // A completion can race this history snapshot. Re-read persisted,
      // authorized messages instead of replaying cached source text.
      if (pending && (!pending.messageId || !conversation.messages?.some(message => message.id === pending.messageId))) {
        const refreshed = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}?limit=50`, { headers: apiHeaders(), signal: controller.signal });
        if (!refreshed.ok) throw new Error('会话加载失败');
        conversation = await refreshed.json() as ConversationPayload;
        if (seq !== openSeqRef.current) return;
      }
      pendingAnswersRef.current.delete(id);
      const active = pending ? null : conversation.activeRun || runsRef.current.get(id);
      if (active) adoptRunStages([{ id, runId: active.runId, runStage: active.stage }]);
      const mapped = mapConversationMessages(conversation);
      if (mapped[mapped.length - 1]?.role === 'user') mapped.push({ role: 'ai', text: active ? ''
        : '该回答未完成，请重新提问。', done: !active, trace: [] });
      setMessages(mapped);
      setCitations(collectConversationCitations(conversation));
      setHistoryMore(conversation.hasMore === true);
      setHistoryCursor(conversation.nextCursor || null);
    } catch (error) {
      if (seq === openSeqRef.current && !controller.signal.aborted) emitToast(errorMessage(error) || '会话加载失败');
    } finally {
      if (seq === openSeqRef.current) setConvLoading(false);
    }
  }, [adoptRunStages]);

  const loadOlderMessages = useCallback(async () => {
    const id = viewKeyRef.current;
    if (!id || !historyMore || !historyCursor || historyLoading) return;
    const seq = openSeqRef.current;
    setHistoryLoading(true);
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight || 0;
    const previousTop = element?.scrollTop || 0;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations/${id}?limit=50&before=${encodeURIComponent(historyCursor)}`, { headers: apiHeaders(), signal: historyControllerRef.current?.signal });
      if (!response.ok) throw new Error('历史消息加载失败');
      const page = await response.json() as ConversationPayload;
      if (seq !== openSeqRef.current || viewKeyRef.current !== id) return;
      const older = mapConversationMessages(page);
      setAutoStick(false);
      setMessages(current => {
        const seen = new Set(current.map(message => message.id));
        return [...older.filter(message => !seen.has(message.id)), ...current];
      });
      setHistoryMore(page.hasMore === true); setHistoryCursor(page.nextCursor || null);
      requestAnimationFrame(() => {
        if (element && viewKeyRef.current === id) element.scrollTop = previousTop + element.scrollHeight - previousHeight;
      });
    } catch (error) {
      if (seq === openSeqRef.current) emitToast(errorMessage(error) || '历史消息加载失败');
    } finally { if (seq === openSeqRef.current) setHistoryLoading(false); }
  }, [historyMore, historyCursor, historyLoading]);

  // 命令面板跨屏打开会话：订阅最新的 openConversation，保证流式期间守卫生效。
  useEffect(() => {
    const onOpen = (e: Event) => { const detail = (e as CustomEvent<string>).detail; if (detail) void openConversation(detail); };
    window.addEventListener('app-open-conversation', onOpen);
    return () => window.removeEventListener('app-open-conversation', onOpen);
  }, [openConversation]);

  const hideConversation = (conv: ConversationSummary) => {
    const id = conv?.id;
    if (!id) return;
    setHiddenConvs(current => new Set(current).add(id));
    if (activeConv === id) { setMessages([]); setActiveConv(null); setCitations([]); viewKeyRef.current = null; setViewKey(null); }
    const onUndo = () => setHiddenConvs(current => { const next = new Set(current); next.delete(id); return next; });
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
      if (!res.ok) throw new Error('会话重命名失败');
      {
        setConversationList((prev) => prev.map((item) => item.id === conv.id ? { ...item, title: newTitle.trim() } : item));
        window.dispatchEvent(new CustomEvent('app-toast', { detail: '会话标题已更新' }));
      }
    } catch (error) { emitToast(errorMessage(error, '会话重命名失败')); }
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


  const autoGrow = (el: HTMLTextAreaElement)=>{
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const answerDone = messages.length>0 && messages[messages.length-1].done;

  // 会话分组按列表/搜索/隐藏集合记忆化：输入框打字等高频重渲染不再
  // 重复做 O(n) 的日期分组过滤。
  /** 会话 id → 当前阶段文案，供侧栏行内图标使用。 */
  const runLabelByConv = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, run] of runs) {
      const label = labelForRun(run);
      if (label) map.set(id, label);
    }
    return map;
  }, [runs]);

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
      {convOpen && <div className="conv-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setConvOpen(false); }} />}
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
                    {g.items.map(conversation => <ConversationRow key={conversation.id} conversation={conversation}
                      active={activeConv === conversation.id} runLabel={runLabelByConv.get(conversation.id)}
                      onOpen={openConversation} onMenu={showConvMenu} />)}
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
            {historyMore && <button type="button" onClick={() => void loadOlderMessages()} disabled={historyLoading}>
              {historyLoading ? '正在加载…' : '加载更早消息'}
            </button>}
            {messages.length===0 && !convLoading && (
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
                key={msg.id || `${viewKey || 'draft'}-${mi}`}
                msg={msg}
                scopeLabel={scopeLabel}
                allSel={allSel}
                selectedCount={selected.length}
                activeCitation={activeCite}
                conversationId={activeConv}
                stageLabel={mi === messages.length - 1 ? stageLabel : null}
                stageKey={mi === messages.length - 1 ? viewStage : null}
                lastUserText={lastUserText}
                onCitation={handleAnswerCitation}
                onPreview={previewCitation}
                onCopy={copyAnswer}
                onResend={resend}
                onFeedback={saveFeedback}
                onVisible={recordVisibleAnswer}
                measureRender={Boolean(activeConv && renderMeasurementsRef.current.get(activeConv)?.messageId === msg.id)}
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
                onChange={e=>{inputRef.current = e.target.value; setInput(e.target.value); autoGrow(e.target);}}
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
                  <button type="button" className="send-btn" onClick={()=>send()} disabled={convLoading || !input.trim() || selected.length===0} title="发送 (Enter)" aria-label="发送">
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
                const n = c.citationIndex || idx + 1;
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
  /** 当前运行阶段文案：用于状态提示 */
  stageLabel?: string | null;
  /** 当前运行阶段键：非流式下没有 trace 节点，管线进度靠它 */
  stageKey?: string | null;
  lastUserText?: string;
  onCitation: (source: Citation, index: number) => void;
  onPreview: (citation: Citation) => void;
  onCopy: (text: string) => void;
  onResend: (question?: string) => void;
  onFeedback: (feedback: string, messageId?: string) => void;
  measureRender?: boolean;
  onVisible: (conversationId: string, messageId: string, done: boolean, at: number) => void;
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
  stageLabel, stageKey, onCitation, onPreview, onCopy, onResend, onFeedback, onVisible, measureRender,
}: MessageItemProps) {
  const traceNodes = useMemo(() => (Array.isArray(msg.trace) ? (msg.trace as TraceNode[]) : []), [msg.trace]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = bodyRef.current;
    if (!measureRender || !root || !msg.text.trim() || !msg.id || !conversationId) return;
    return observeAnswerVisibility(root, at => onVisible(conversationId, msg.id!, Boolean(msg.done), at));
  }, [msg.text, msg.id, msg.done, conversationId, onVisible, measureRender]);
  return (
    <div className="msg msg-ai">
      <div className="body" ref={bodyRef}>
        <div className="who">
          <span className="dot"/>
          <span>百纳 · 大脑综述</span>
          <span style={{color:'var(--ink-4)'}}>· 你的大脑 · {scopeLabel}{allSel ? `（${selectedCount} 库）` : ''}</span>
        </div>
        {/* 生成期间展示动态管线进度：非流式下没有 trace 节点，改用 run 的阶段 */}
        {!msg.done && (traceNodes.length > 0 || stageKey) && <PipelineProgress nodes={traceNodes} stage={stageKey} />}
        <AnswerMarkdown content={msg.text} sources={msg.sources} activeCitation={activeCitation} streaming={!msg.done} onCitation={onCitation} />
        {msg.done && (msg.sources?.length ?? 0) > 0 && (
          <div className="answer-sources"><span>来源：</span>{(msg.sources || []).map((source: Citation, index: number) => <button key={source.id || index} onClick={()=>onPreview(source)} title="打开原始文档预览">[{source.citationIndex || index + 1}] {source.title}</button>)}</div>
        )}
        {/* 历史消息不再随会话列表下发 trace（单条可达百 KB），折叠时按需拉取。
            生成中的消息还没有 messageId 可拉取，改用当前阶段显示调用链进度 ——
            否则这一栏在整轮生成期间完全不出现（生产回归）。 */}
        {msg.done && msg.id && conversationId
          ? <TraceDetails nodes={traceNodes} conversationId={conversationId} messageId={msg.id} />
          : (!msg.done && stageLabel)
            ? <TraceDetails nodes={traceNodes} liveStage={stageLabel} />
            : traceNodes.length > 0 && <TraceDetails nodes={traceNodes} />}
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

/**
 * `stage` is the only progress signal while a non-streaming run is in flight:
 * the trace is persisted with the finished answer, so there are no nodes to
 * read mid-turn. The backend's coarse stage maps onto the same six chips, which
 * is what kept this view alive after streaming was removed.
 */
const STAGE_TO_PIPELINE: Record<string, string> = {
  queued: 'query_rewrite',
  retrieving: 'gbrain_retrieval',
  reranking: 'confidence_rerank',
  generating: 'llm_generation',
  verifying: 'grounding_gate',
  persisting: 'citation_validation',
};

function PipelineProgress({ nodes, stage }: { nodes: TraceNode[]; stage?: string | null }) {
  const activeIds = new Set(nodes.map((n) => n.id));
  const doneIds = new Set(nodes.filter((n) => n.status === 'success' || n.status === 'skipped').map((n) => n.id));
  const runningIds = new Set(nodes.filter((n) => n.status === 'running').map((n) => n.id));
  const stageNode = stage ? STAGE_TO_PIPELINE[stage] : undefined;
  // With no nodes yet, mark every stage before the current one as reached so the
  // chips fill in left to right instead of all sitting at "pending".
  if (stageNode && nodes.length === 0) {
    const index = PIPELINE_STAGES.findIndex(([id]) => id === stageNode);
    PIPELINE_STAGES.slice(0, Math.max(index, 0)).forEach(([id]) => { doneIds.add(id); activeIds.add(id); });
    if (index >= 0) { runningIds.add(stageNode); activeIds.add(stageNode); }
  }
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
const TraceDetails = memo(function TraceDetails({ nodes, conversationId, messageId, liveStage }: { nodes: TraceNode[]; conversationId?: string; messageId?: string; liveStage?: string | null }) {
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
  const displayNodes = useMemo(() => nodes.length > 0 ? nodes : (lazyNodes ?? []), [nodes, lazyNodes]);
  // Recomputed over the nodes on screen, not taken from the parent: after the
  // lazy fetch `nodes` is still empty and the inherited stats read 0/0.
  const displayStats = useMemo(() => summarizeTrace(displayNodes), [displayNodes]);
  return (
    <details className="retrieval" onToggle={onToggle}>
      <summary>
        <Icon name="spark" size={12} color="var(--evidence)"/>
        <span>本次响应处理调用链 ·</span>
        {displayStats.total === 0 && liveStage
          ? <b>{STAGE_LABELS[liveStage as RunStage] ?? '处理中'}</b>
          : displayStats.total === 0 && lazyNodes === null && nodes.length === 0
            ? <b>{lazyLoading ? '加载中…' : '展开查看'}</b>
            : <b>{displayStats.failed ? `${displayStats.failed} 个异常` : displayStats.running ? `${displayStats.running} 个执行中` : `${displayStats.success}/${displayStats.total} 个节点正常`}</b>}
        {displayStats.warnings > 0 && <span className="trace-summary-warning">· {displayStats.warnings} 个警告</span>}
        {displayStats.duration !== null && <span className="trace-total">{displayStats.duration}ms</span>}
        <span className="trace-expand">展开 ▾</span>
      </summary>
      {open && (
        <div className="retrieval-body">
          {displayNodes.length === 0 && <div className="ret-step">暂无调用链记录</div>}
          {displayNodes.map((node: TraceNode, index: number) => {
            // 检索漏斗行（评审 §5）：evidence_selection 节点携带
            // 召回→重排→入选 数字时，在节点摘要下以单行数字展示，
            // 普通用户无需展开 JSON。
            const details = (node.details ?? {}) as { selection?: { funnel?: { recalled: number; rerankScored: number; eligible: number; selected: number } } };
            const funnel = details?.selection?.funnel as
              { recalled: number; rerankScored: number; eligible: number; selected: number } | undefined;
            return (
            <div className={`ret-step trace-${String(node.status ?? '')}`} key={node.id || index}>
              <span className="n">{node.status === 'success' ? '✓' : node.status === 'warning' ? '!' : node.status === 'failed' ? '×' : node.status === 'skipped' ? '–' : '…'}</span>
              <span className="txt">
                <b>{String(node.name ?? '')}</b>
                {node.summary ? ` · ${String(node.summary ?? '')}` : ''}
                {funnel && (
                  <div className="ret-funnel">
                    漏斗：召回 {funnel.recalled} → 重排实测 {funnel.rerankScored} → 入池 {funnel.eligible} → 入选 {funnel.selected}
                  </div>
                )}
                {node.details && Object.keys(node.details).length > 0 && (
                  <details className="trace-details">
                    <summary>查看节点反馈</summary>
                    <pre>{JSON.stringify(node.details, null, 2)}</pre>
                  </details>
                )}
              </span>
              <span className="v">{node.status === 'running' ? '执行中' : node.status === 'skipped' ? '跳过' : `${node.durationMs ?? 0}ms`}</span>
            </div>
            );
          })}
        </div>
      )}
    </details>
  );
});
