"use client";
import { useEffect, useState } from 'react';

export type ThemeName = 'light' | 'dark';

/** Theme selection kept identical across server HTML and first client render. */
export function useTheme(): [ThemeName | null, (next: ThemeName | ((prev: ThemeName | null) => ThemeName)) => void] {
  const [theme, setTheme] = useState<ThemeName | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem('llmwiki_theme');
    setTheme(saved === 'dark' || saved === 'light'
      ? saved
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('llmwiki_theme', theme);
  }, [theme]);

  return [theme, setTheme];
}
