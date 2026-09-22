import React, { useEffect, useRef } from 'react';
import { Icon } from '@/components/common/Icon';
import type { KbInfo } from '@/types';

export interface ScopePickerProps {
  visibleKbs: KbInfo[];
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function ScopePicker({ visibleKbs, selected, setSelected, open, setOpen }: ScopePickerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [setOpen]);
  const groups = [
    { label: '个人库', items: visibleKbs.filter((k) => k.type === 'personal') },
    { label: '组织库', items: visibleKbs.filter((k) => k.type === 'org') },
    { label: '行业库', items: visibleKbs.filter((k) => k.type === 'industry') },
  ];
  const totalSel = selected.length;
  const totalAll = visibleKbs.length;
  const scopeLabel = totalSel === totalAll ? '我可见的全部' : (totalSel === 0 ? '未选择任何库' : `已选 ${totalSel} 库`);
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button className="scope-trigger" onClick={() => setOpen(!open)} title="调整本次对话的检索范围">
        <span className="scope-dot" style={{ background: totalSel === 0 ? 'var(--ink-4)' : 'var(--evidence)' }}/>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeLabel}</span>
        <span className="scope-meta">{totalSel}/{totalAll} 库</span>
        <Icon name="chevron" size={14} color="var(--ink-3)" style={{ transform: open ? 'rotate(-90deg)' : 'rotate(90deg)', transition: 'transform .15s' }}/>
      </button>
      {open && (
        <div className="scope-pop">
          <h5>选择查询范围</h5>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {groups.map((g) => (
              <div className="group" key={g.label}>
                <div className="gh">
                  <span>{g.label}</span>
                  <span>{g.items.length} 个</span>
                </div>
                {g.items.map((k) => {
                  const checked = selected.includes(k.id);
                  return (
                      <div key={k.id} className="gi" onClick={() => {
                        setSelected(checked ? selected.filter((x) => x !== k.id) : [...selected, k.id]);
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => {}} style={{ accentColor: 'var(--ink)' }}/>
                        <span className="gname">{k.name}</span>
                        <span className="gvis">{k.visibility || '—'}</span>
                      </div>
                    );
                })}
              </div>
            ))}
          </div>
          <div className="foot">
            <button onClick={() => setSelected(visibleKbs.map((k) => k.id))}>全选</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setSelected([])}>清空</button>
              <button className="primary" onClick={() => setOpen(false)}>应用</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
