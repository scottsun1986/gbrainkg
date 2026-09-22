import React, { useEffect, useRef } from 'react';
import { Icon } from '@/components/common/Icon';
import type { CtxMenuItem } from '@/types';

export interface ContextMenuProps {
  x: number;
  y: number;
  items: CtxMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
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
          {it.shortcut && <span className="kbd" style={{ marginLeft: 'auto' }}>{it.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
