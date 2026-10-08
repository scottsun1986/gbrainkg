"use client";

import React, { useState } from 'react';
import { Icon } from '@/components/common/Icon';
import dynamic from 'next/dynamic';

const LocalTotpQrCode = dynamic(() => import('./LocalTotpQrCode').then(module => module.LocalTotpQrCode), { ssr: false });

export interface LoginScreenProps {
  onSubmit: (username: string, password: string) => void;
  error?: string;
  loading?: boolean;
  oidcEnabled?: boolean;
  onOidcLogin?: () => void;
}

export function LoginScreen({ onSubmit, error, loading, oidcEnabled, onOidcLogin }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 };
  return (
    <div className="login-shell" role="main">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
        <div className="login-brand-row">
          <div className="login-brand-mark">百</div>
          <h1 className="login-title">百纳<small>企业级知识库</small></h1>
        </div>
        <div className="login-lead">登录你的企业大脑 · 答案可溯源</div>
        <label className="login-label" htmlFor="login-username">账号</label>
        <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus placeholder="请输入账号" style={inputStyle} />
        <label className="login-label" htmlFor="login-password">密码</label>
        <input id="login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="请输入密码" style={{ ...inputStyle, marginBottom: 18 }} />
        {error && (
          <div className="login-error" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}
        <button type="submit" disabled={loading || !username || !password} className="btn primary" style={{ width: '100%', justifyContent: 'center' }}>
          {loading ? '登录中…' : '登录'}
        </button>
        {oidcEnabled && onOidcLogin && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 14px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>或</span>
              <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>
            <button type="button" onClick={onOidcLogin} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
              企业 SSO 登录
            </button>
          </>
        )}
        <div className="login-foot-tip">回答附带原文引用 · 权限边界服务端校验 · 会话数据加密传输</div>
      </form>
    </div>
  );
}

export interface MfaScreenProps {
  onSubmit: (code: string) => void;
  onLogout: () => void;
  error?: string;
  loading?: boolean;
  title?: string;
  hint?: string;
}

/** Second-factor step after a password (or SSO) check: one TOTP code. */
export function MfaScreen({ onSubmit, onLogout, error, loading, title, hint }: MfaScreenProps) {
  const [code, setCode] = useState('');
  const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 };
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); if (code.trim()) onSubmit(code.trim()); }}>
        <div className="login-brand-row">
          <div className="login-brand-mark">百</div>
          <div className="login-title">{title || '两步验证'}<small>账户安全</small></div>
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>
          {hint || '请输入身份验证器（TOTP）上的 6 位动态验证码。'}
        </div>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>动态验证码</label>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="000000"
          style={{ ...inputStyle, letterSpacing: '0.3em', fontSize: 18 }}
        />
        {error && <div className="login-error" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
        <button type="submit" disabled={loading || code.trim().length < 6} className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 11 }}>
          {loading ? '验证中…' : '验证并登录'}
        </button>
        <button type="button" onClick={onLogout} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 11, marginTop: 10 }}>退出</button>
      </form>
    </div>
  );
}

export interface MfaSetupScreenProps {
  secret?: string;
  otpauthUri?: string;
  onSubmit: (code: string) => void;
  onLogout: () => void;
  error?: string;
  loading?: boolean;
}

/** Forced (or first-run) TOTP enrolment: show secret/URI, confirm with a code. */
export function MfaSetupScreen({ secret, otpauthUri, onSubmit, onLogout, error, loading }: MfaSetupScreenProps) {
  const [code, setCode] = useState('');
  const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 };
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); if (code.trim()) onSubmit(code.trim()); }}>
        <div className="login-brand-row">
          <div className="login-brand-mark">百</div>
          <div className="login-title">设置两步验证<small>账户安全</small></div>
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.7, marginBottom: 20 }}>
          请使用身份验证器 App（Google Authenticator / 1Password 等）扫描二维码或手动输入密钥，然后填入 6 位动态验证码完成绑定。
        </div>
        {otpauthUri && (
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <LocalTotpQrCode key={otpauthUri} otpauthUri={otpauthUri} />
          </div>
        )}
        {secret && (
          <>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>手动输入密钥</label>
            <input readOnly value={secret} style={{ ...inputStyle, fontFamily: 'ui-monospace,monospace', letterSpacing: '0.08em' }} onFocus={(event) => event.currentTarget.select()} />
          </>
        )}
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>动态验证码</label>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          style={{ ...inputStyle, letterSpacing: '0.3em', fontSize: 18 }}
        />
        {error && <div className="login-error" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
        <button type="submit" disabled={loading || code.trim().length < 6} className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: 11 }}>
          {loading ? '绑定中…' : '确认绑定'}
        </button>
        <button type="button" onClick={onLogout} className="btn" style={{ width: '100%', justifyContent: 'center', padding: 11, marginTop: 10 }}>退出</button>
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
        <div className="login-brand-row">
          <div className="login-brand-mark">百</div>
          <div className="login-title">首次登录安全设置<small>账户安全</small></div>
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>为了保护生产环境，请先修改 admin 的初始化密码。</div>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>当前密码</label>
        <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 }} />
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>新密码</label>
        <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 16 }} />
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--ink-2)' }}>确认新密码</label>
        <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 12px', borderRadius: 8, marginBottom: 18 }} />
        {(localError || error) && <div className="login-error" role="alert"><Icon name="alert" size={14} /><span>{localError || error}</span></div>}
        <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '保存中…' : '保存新密码'}</button>
        <button type="button" onClick={onLogout} className="btn" style={{width:'100%',justifyContent:'center',padding:11,marginTop:10}}>退出</button>
      </form>
    </div>
  );
}
