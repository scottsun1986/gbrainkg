"use client";
import { useEffect, useRef, useState } from 'react';
import type { ToastState } from '@/types';

/** Transient toast driven by the app-toast / app-undoable event bus. */
export function useToast(): [ToastState | null, (next: ToastState | null) => void] {
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const schedule = (state: ToastState, ms: number) => {
      setToast(state);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), ms);
    };
    const h = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      schedule({ text: detail, undo: null }, 4000);
    };
    const u = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { message?: string; undoLabel?: string; undo?: (() => void) | null };
      schedule({
        text: d.message || '已操作',
        undo: d.undo ? { label: d.undoLabel || '撤销', fn: d.undo } : null,
      }, 5000);
    };
    window.addEventListener('app-toast', h);
    window.addEventListener('app-undoable', u);
    return () => {
      window.removeEventListener('app-toast', h);
      window.removeEventListener('app-undoable', u);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  return [toast, setToast];
}
