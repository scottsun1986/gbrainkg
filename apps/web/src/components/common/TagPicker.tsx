import React, { useState } from 'react';
import type { TagItem } from '@/types';

export interface TagPickerProps {
  placeholder?: string;
  items: TagItem[];
  selected: TagItem[];
  setSelected: React.Dispatch<React.SetStateAction<TagItem[]>>;
}

export function TagPicker({ placeholder, items, selected, setSelected }: TagPickerProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = items.filter((it) => !selected.find((s) => s.id === it.id) && ((it.name || '').includes(q) || (it.n || '').includes(q)));
  return (
    <div style={{ position: 'relative' }}>
      <div className="tag-input" onClick={() => setOpen(true)}>
        {selected.map((s) => (
          <span key={s.id} className="chip">
            {s.n || s.name}
            <span className="x" onClick={(e) => { e.stopPropagation(); setSelected(selected.filter((x) => x.id !== s.id)); }}>×</span>
          </span>
        ))}
        <input
          placeholder={selected.length === 0 ? placeholder : ''}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          style={{ flex: 1, minWidth: 80, border: 'none', outline: 'none', background: 'transparent', fontSize: '12.5px', padding: '4px 4px' }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="tag-suggest" style={{ top: 38, left: 0, right: 0 }}>
          {filtered.map((it) => (
            <div key={it.id} className="ts" onMouseDown={() => { setSelected([...selected, it]); setQ(''); }}>
              <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{it.n || it.name}</span>
              <span style={{ color: 'var(--ink-4)', marginLeft: 6, fontSize: 11 }}>{it.sub || it.org || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
