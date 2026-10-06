"use client";
import { useEffect, useState } from 'react';

export type ThemeName = 'light' | 'dark';

/** Theme selection kept identical across server HTML and first client render. */
export function useTheme(): [ThemeName | null, (next: ThemeName | ((prev: ThemeName | null) => ThemeName)) => void] {
  const [theme, setTheme] = useState<ThemeName | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem('llmwiki_theme'); } catch { /* storage may be blocked */ }
    setTheme(saved === 'dark' || saved === 'light'
      ? saved
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('llmwiki_theme', theme); } catch { /* theme remains usable without storage */ }
  }, [theme]);

  return [theme, setTheme];
}
