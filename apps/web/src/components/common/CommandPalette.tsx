import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { canAccessAdmin } from '@/lib/capabilities';
import { TYPE_LABEL } from '@/lib/design-tokens';
import { appStore } from '@/lib/app-store';
import type { ConversationSummary, KbInfo } from '@/types';

export type PaletteNavPayload = { kbId?: string; convId?: string } | undefined;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNav: (target: string, payload?: PaletteNavPayload) => void;
  onNewChat: () => void;
  onNewKb: () => void;
  onUpload: () => void;
  conversations?: ConversationSummary[];
  knowledgeBases?: KbInfo[];
  initialQuery?: string;
}

interface PaletteItem {
  id: string;
  label: string;
  sub?: string;
  hint?: string;
  icon: string;
  run: () => void;
}

export function CommandPalette({ open, onClose, onNav, onNewChat, onNewKb, onUpload, conversations = [], knowledgeBases = [], initialQuery = '' }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQuery(''); setHighlight(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setQuery(initialQuery); setHighlight(0); }, [initialQuery]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: Array<{ label: string; items: PaletteItem[] }> = [];
    groups.push({ label: '导航', items: [
      { id: 'nav-chat', label: '去对话', hint: '⌘1', icon: 'chat', run: () => onNav('chat') },
      { id: 'nav-libs', label: '去知识库', hint: '⌘2', icon: 'book', run: () => onNav('libs') },
      { id: 'nav-graph', label: '去知识图谱', hint: '⌘3', icon: 'share', run: () => onNav('graph') },
      ...(canAccessAdmin(appStore.CAPABILITIES) ? [{ id: 'nav-admin', label: '去管理后台', hint: '⌘4', icon: 'shield', run: () => onNav('admin') }] : []),
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
    const onKey = (e: KeyboardEvent) => {
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
