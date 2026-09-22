"use client";
import { useEffect } from 'react';

export interface HotkeyHandlers {
  onTogglePalette: () => void;
  onToggleSideCollapsed: () => void;
  onEscape: () => void;
  onHelp: () => void;
  onNav: (screen: string) => void;
  onNewChat: () => void;
  paletteOpen: boolean;
}

/** Global ⌘/Ctrl shortcuts from the prototype. */
export function useAppHotkeys(handlers: HotkeyHandlers): void {
  const {
    onTogglePalette, onToggleSideCollapsed, onEscape, onHelp, onNav, onNewChat, paletteOpen,
  } = handlers;

  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName || '').toLowerCase();
      const inEditable = tag === 'input' || tag === 'textarea' || Boolean(target?.isContentEditable);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); onTogglePalette(); return; }
      if (mod && (e.key === '\\')) { e.preventDefault(); onToggleSideCollapsed(); return; }
      if (e.key === 'Escape') { if (paletteOpen) { onEscape(); e.preventDefault(); } return; }
      if (inEditable) return;
      if (e.key === '?' && !mod && !e.altKey) { e.preventDefault(); onHelp(); return; }
      if (mod && (e.key === '1')) { e.preventDefault(); onNav('chat'); return; }
      if (mod && (e.key === '2')) { e.preventDefault(); onNav('libs'); return; }
      if (mod && (e.key === '3')) { e.preventDefault(); onNav('graph'); return; }
      if (mod && (e.key === '4')) { e.preventDefault(); onNav('admin'); return; }
      if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); onNewChat(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onTogglePalette, onToggleSideCollapsed, onEscape, onHelp, onNav, onNewChat, paletteOpen]);
}
