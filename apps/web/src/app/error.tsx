'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('LLMWiki page error:', error);
  }, [error]);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#F7F6F3', color: '#191817' }}>
      <section style={{ width: 'min(440px, 100%)', padding: 32, border: '1px solid #E7E4DD', borderRadius: 14, background: '#fff', textAlign: 'center', boxShadow: '0 12px 36px rgba(25,24,23,.08)' }}>
        <div style={{ fontSize: 30, marginBottom: 12 }}>!</div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>页面暂时无法加载</h1>
        <p style={{ color: '#6F6B63', lineHeight: 1.7, marginBottom: 22 }}>刚才的操作没有完成，请重试。已有的登录状态不会丢失。</p>
        <button onClick={() => reset()} style={{ padding: '9px 18px', borderRadius: 7, background: '#191817', color: '#fff' }}>重新加载</button>
      </section>
    </main>
  );
}
