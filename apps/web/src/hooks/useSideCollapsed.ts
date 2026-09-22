"use client";
import { useCallback, useEffect, useState } from 'react';

/** Persisted sidebar collapse state (⌘\). */
export function useSideCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('llmwiki_side_collapsed');
      if (saved === 'true') setCollapsed(true);
    } catch { /* ignore */ }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try { window.localStorage.setItem('llmwiki_side_collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return [collapsed, toggle];
}
