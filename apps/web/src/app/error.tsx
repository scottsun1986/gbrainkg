'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('百纳 page error:', error);
    // Add more context to the error log
    console.error('Error details:', { digest: error.digest, message: error.message, stack: error.stack });
  }, [error]);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)', color: 'var(--ink)' }}>
      <section style={{ width: 'min(440px, 100%)', padding: 32, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--surface)', textAlign: 'center', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ fontSize: 30, marginBottom: 12 }}>!</div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>抱歉，页面遇到了一些问题</h1>
        <p style={{ color: 'var(--ink-3)', lineHeight: 1.7, marginBottom: 22 }}>发生了一个未预期的错误，请重试。如果您反复遇到此问题，请联系管理员。</p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button onClick={() => reset()} style={{ padding: '9px 18px', borderRadius: 7, background: 'var(--ink)', color: 'var(--on-ink)', border: 'none', cursor: 'pointer' }}>重试</button>
          <Link href="/" style={{ padding: '9px 18px', borderRadius: 7, background: 'var(--surface-2)', color: 'var(--ink)', textDecoration: 'none', border: '1px solid var(--line)', cursor: 'pointer' }}>返回首页</Link>
        </div>
      </section>
    </main>
  );
}
