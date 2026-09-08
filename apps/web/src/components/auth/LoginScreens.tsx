"use client";

import React, { useState } from 'react';

export function LoginScreen({ onSubmit, error, loading }: any) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={(event) => { event.preventDefault(); onSubmit(username, password); }}>
        <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:10}}>
          <span style={{fontSize:28,fontWeight:700,letterSpacing:'-0.02em',color:'#191817'}}>GBrain</span>
          <span style={{fontSize:12,color:'#9C978C',letterSpacing:'0.04em'}}>企业级知识库</span>
        </div>
        <div style={{color:'#756f66',fontSize:14,marginBottom:28}}>登录你的企业大脑</div>
        <label style={{display:'block',fontSize:13,marginBottom:6}}>账号</label>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>密码</label>
        <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" autoFocus style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:18}} />
        {error && <div style={{color:'#b42318',fontSize:13,marginBottom:14}}>{error}</div>}
        <button type="submit" disabled={loading || !username || !password} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}

export function PasswordChangeScreen({ onSubmit, onLogout, error, loading }: any) {
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
        <div style={{fontSize:28,fontWeight:700,letterSpacing:'-0.02em',color:'#191817',marginBottom:10}}>首次登录安全设置</div>
        <div style={{color:'#756f66',fontSize:14,lineHeight:1.7,marginBottom:24}}>为了保护生产环境，请先修改 admin 的初始化密码。</div>
        <label style={{display:'block',fontSize:13,marginBottom:6}}>当前密码</label>
        <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>新密码</label>
        <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:16}} />
        <label style={{display:'block',fontSize:13,marginBottom:6}}>确认新密码</label>
        <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" style={{width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid #d8d2c8',borderRadius:7,marginBottom:18}} />
        {(localError || error) && <div style={{color:'#b42318',fontSize:13,marginBottom:14}}>{localError || error}</div>}
        <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="btn primary" style={{width:'100%',justifyContent:'center',padding:11}}>{loading ? '保存中…' : '保存新密码'}</button>
        <button type="button" onClick={onLogout} className="btn" style={{width:'100%',justifyContent:'center',padding:11,marginTop:10}}>退出</button>
      </form>
    </div>
  );
}
