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
    console.error('GBrain page error:', error);
    // Add more context to the error log
    console.error('Error details:', { digest: error.digest, message: error.message, stack: error.stack });
  }, [error]);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#F7F6F3', color: '#191817' }}>
      <section style={{ width: 'min(440px, 100%)', padding: 32, border: '1px solid #E7E4DD', borderRadius: 14, background: '#fff', textAlign: 'center', boxShadow: '0 12px 36px rgba(25,24,23,.08)' }}>
        <div style={{ fontSize: 30, marginBottom: 12 }}>!</div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>抱歉，页面遇到了一些问题</h1>
        <p style={{ color: '#6F6B63', lineHeight: 1.7, marginBottom: 22 }}>发生了一个未预期的错误，请重试。如果您反复遇到此问题，请联系管理员。</p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button onClick={() => reset()} style={{ padding: '9px 18px', borderRadius: 7, background: '#191817', color: '#fff', border: 'none', cursor: 'pointer' }}>重试</button>
          <a href="/" style={{ padding: '9px 18px', borderRadius: 7, background: '#F7F6F3', color: '#191817', textDecoration: 'none', border: '1px solid #E7E4DD', cursor: 'pointer' }}>返回首页</a>
        </div>
      </section>
    </main>
  );
}
