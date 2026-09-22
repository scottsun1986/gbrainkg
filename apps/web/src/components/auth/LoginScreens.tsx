"use client";

import React, { useState } from 'react';

export interface LoginScreenProps {
  onSubmit: (username: string, password: string) => void;
  error?: string;
  loading?: boolean;
}

export function LoginScreen({ onSubmit, error, loading }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 };
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
        <div className="login-brand-mark">百</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ink)', fontFamily: '"Source Serif 4","Noto Serif SC",serif' }}>百纳</span>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>企业级知识库</span>
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, marginBottom: 28 }}>登录你的企业大脑 · 答案可溯源</div>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>账号</label>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="请输入账号" style={inputStyle} />
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>密码</label>
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" autoFocus placeholder="请输入密码" style={{ ...inputStyle, marginBottom: 18 }} />
        {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <button type="submit" disabled={loading || !username || !password} className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 11 }}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}

export interface PasswordChangeScreenProps {
  onSubmit: (currentPassword: string, newPassword: string) => void;
  onLogout: () => void;
  error?: string;
  loading?: boolean;
}

export function PasswordChangeScreen({ onSubmit, onLogout, error, loading }: PasswordChangeScreenProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => {
        event.preventDefault();
        if (newPassword.length < 12) return setLocalError('新密码至少需要 12 个字符');
        if (newPassword !== confirmPassword) return setLocalError('两次输入的新密码不一致');
        setLocalError('');
        onSubmit(currentPassword, newPassword);
      }}>
        <div className="login-brand-mark">百</div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ink)', fontFamily: '"Source Serif 4","Noto Serif SC",serif', marginBottom: 10 }}>首次登录安全设置</div>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>为了保护生产环境，请先修改 admin 的初始化密码。</div>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>当前密码</label>
        <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 }} />
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>新密码</label>
        <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 }} />
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>确认新密码</label>
        <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 18 }} />
        {(localError || error) && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 14 }}>{localError || error}</div>}
        <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '保存中…' : '保存新密码'}</button>
        <button type="button" onClick={onLogout} className="btn" style={{width:'100%',justifyContent:'center',padding:11,marginTop:10}}>退出</button>
      </form>
    </div>
  );
}
