"use client";

/*
 * Route / layout shell for the interactive prototype.  Screens live in
 * `src/components/**`, shared helpers in `src/lib/**`, and domain types in
 * `src/types/**`.  Runtime behaviour is covered by the API/e2e checks.
 */
/* eslint-disable */
import React, { useState, useEffect, useRef } from "react";
import { LoginScreen, PasswordChangeScreen, MfaScreen, MfaSetupScreen } from "@/components/auth/LoginScreens";
import { KnowledgeGraphScreen } from "@/components/knowledge-graph/KnowledgeGraphScreen";
import { PersonalSettingsScreen } from "@/components/settings/PersonalSettingsScreen";
import { SideNav } from "@/components/common/SideNav";
import { TopBar } from "@/components/common/TopBar";
import { CommandPalette } from "@/components/common/CommandPalette";
import { HelpOverlay } from "@/components/common/HelpOverlay";
import {
  UniversalDocumentViewer,
  OnlinePreviewModal,
} from "@/components/preview/UniversalDocumentViewer";
import { ChatScreen } from "@/components/chat/ChatScreen";
import { LibrariesScreen } from "@/components/libraries/LibrariesScreen";
import { AdminScreen } from "@/components/admin/AdminScreen";
import { API_BASE_URL, apiHeaders } from "@/lib/api";
import { appStore } from "@/lib/app-store";
import { errorMessage, apiMessage } from "@/lib/errors";
import { emitNewChat, emitNewKb, emitFocusUpload, emitOpenConversation } from "@/lib/app-events";
import { canAccessAdmin, canAccessSettings } from "@/lib/capabilities";
import { useTheme } from "@/hooks/useTheme";
import { useToast } from "@/hooks/useToast";
import { useAppHotkeys } from "@/hooks/useAppHotkeys";
import { useSideCollapsed } from "@/hooks/useSideCollapsed";
import { useAdminBootstrap } from "@/hooks/useAdminBootstrap";
import type { PaletteNavPayload } from "@/components/common/CommandPalette";
import type { PreviewTarget } from "@/types";

type AuthState = 'checking' | 'loggedOut' | 'mustChangePassword' | 'mfaRequired' | 'mfaSetup' | 'loggedIn';

function App() {
  const { loadAdminData, currentUser, setCurrentUser, dbData, setDbData } = useAdminBootstrap();
  // Keep server HTML and the first browser render identical. Reading
  // localStorage in the state initializer caused a production hydration
  // mismatch on a fresh visit and could surface Next's "page couldn't load".
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaSetupInfo, setMfaSetupInfo] = useState<{ secret?: string; otpauthUri?: string }>({});
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/v1/auth/config`)
      .then((r) => (r.ok ? r.json() : { oidcEnabled: false }))
      .then((cfg: { oidcEnabled?: boolean }) => setOidcEnabled(Boolean(cfg?.oidcEnabled)))
      .catch(() => setOidcEnabled(false));
  }, []);

  const completeLogin = React.useCallback(async (token: string, user?: { mustChangePassword?: boolean }) => {
    window.localStorage.setItem('llmwiki_token', token);
    if (user?.mustChangePassword) {
      setPasswordChangeError('');
      setAuthState('mustChangePassword');
      return;
    }
    await loadAdminData(token);
    setAuthState('loggedIn');
  }, [loadAdminData]);

  // OIDC callback lands on /#token=… / #mfa_token=… / #mfa_setup_token=… / #sso_error=…
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash.includes('=') ? hash : `q=${hash}`);
    const token = params.get('token') || (hash.startsWith('token=') ? hash.slice(6) : '');
    const mfa = params.get('mfa_token') || '';
    const mfaSetup = params.get('mfa_setup_token') || '';
    const ssoError = params.get('sso_error') || '';
    if (!token && !mfa && !mfaSetup && !ssoError) return;
    window.history.replaceState({}, '', '/');
    if (ssoError) {
      setLoginError(decodeURIComponent(ssoError));
      setAuthState('loggedOut');
      return;
    }
    if (token) {
      void completeLogin(decodeURIComponent(token)).catch(() => {
        setLoginError('SSO 登录失败，请重试');
        setAuthState('loggedOut');
      });
      return;
    }
    if (mfa) {
      setMfaToken(decodeURIComponent(mfa));
      setAuthState('mfaRequired');
      return;
    }
    if (mfaSetup) {
      setMfaToken(decodeURIComponent(mfaSetup));
      setMfaSetupInfo({});
      setAuthState('mfaSetup');
    }
  }, [completeLogin]);

  useEffect(() => {
    const token = window.localStorage.getItem('llmwiki_token');
    if (!token) {
      setAuthState('loggedOut');
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      window.localStorage.removeItem('llmwiki_token');
      setAuthState('loggedOut');
    }, 3500);

    fetch(`${API_BASE_URL}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return response.json();
      })
      .then(async (me: { user?: { mustChangePassword?: boolean } }) => {
        clearTimeout(timeoutId);
        if (me.user?.mustChangePassword) {
          setAuthState('mustChangePassword');
          return;
        }
        await loadAdminData(token);
        setAuthState('loggedIn');
      })
      .catch(() => {
        clearTimeout(timeoutId);
        window.localStorage.removeItem('llmwiki_token');
        setAuthState('loggedOut');
      });
    return () => clearTimeout(timeoutId);
  }, [loadAdminData]);

  useEffect(() => {
    const refresh = () => {
      const token = window.localStorage.getItem('llmwiki_token');
      if (token) void loadAdminData(token);
    };
    window.addEventListener('app-data-refresh', refresh);
    return () => window.removeEventListener('app-data-refresh', refresh);
  }, [loadAdminData]);

  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) {
        const message = apiMessage(result);
        if (response.status === 429 || (message && String(message).includes('Too Many Requests'))) {
          throw new Error('请求过于频繁，请稍候再试');
        }
        throw new Error(message || '登录失败');
      }
      // Second factor: password (or SSO) ok, but TOTP is still required.
      if ((result as { mfaRequired?: boolean }).mfaRequired) {
        setMfaToken(String((result as { mfaToken?: string }).mfaToken || ''));
        setMfaError('');
        setAuthState('mfaRequired');
        return;
      }
      // requireMfaForAdmins: privileged account must enrol TOTP first.
      if ((result as { mfaSetupRequired?: boolean }).mfaSetupRequired) {
        setMfaToken(String((result as { mfaToken?: string }).mfaToken || ''));
        setMfaSetupInfo({});
        setMfaError('');
        setAuthState('mfaSetup');
        return;
      }
      const token = String((result as { token?: string }).token || '');
      const user = (result as { user?: { mustChangePassword?: boolean } }).user;
      await completeLogin(token, user);
    } catch (error) {
      setLoginError(errorMessage(error) || '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleMfaLogin = async (code: string) => {
    setMfaLoading(true);
    setMfaError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/mfa/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code }),
      });
      const result = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) throw new Error(apiMessage(result) || '动态验证码错误');
      const token = String((result as { token?: string }).token || '');
      const user = (result as { user?: { mustChangePassword?: boolean } }).user;
      await completeLogin(token, user);
    } catch (error) {
      setMfaError(errorMessage(error) || '动态验证码错误');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaSetupStart = async () => {
    setMfaLoading(true);
    setMfaError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/mfa/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mfaToken ? { mfaToken } : {}),
      });
      const result = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) throw new Error(apiMessage(result) || '无法开始 MFA 绑定');
      setMfaSetupInfo({
        secret: String((result as { secret?: string }).secret || ''),
        otpauthUri: String((result as { otpauthUri?: string }).otpauthUri || ''),
      });
    } catch (error) {
      setMfaError(errorMessage(error) || '无法开始 MFA 绑定');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaSetupVerify = async (code: string) => {
    setMfaLoading(true);
    setMfaError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...(mfaToken ? { mfaToken } : {}) }),
      });
      const result = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) throw new Error(apiMessage(result) || '动态验证码错误');
      // Forced-setup login path completes with a real session.
      const token = String((result as { token?: string }).token || '');
      if (token) {
        const user = (result as { user?: { mustChangePassword?: boolean } }).user;
        setMfaToken('');
        await completeLogin(token, user);
        return;
      }
      setMfaToken('');
      setAuthState('loggedOut');
    } catch (error) {
      setMfaError(errorMessage(error) || '动态验证码错误');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleOidcLogin = () => {
    window.location.href = `${API_BASE_URL}/api/v1/auth/oidc/login`;
  };

  // Enrol TOTP as soon as the setup screen opens (once).
  useEffect(() => {
    if (authState !== 'mfaSetup') return;
    if (mfaSetupInfo.secret || mfaLoading || mfaError) return;
    void handleMfaSetupStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, mfaSetupInfo.secret, mfaLoading, mfaError]);

  const handlePasswordChange = async (currentPassword: string, newPassword: string) => {
    setPasswordChangeLoading(true);
    setPasswordChangeError('');
    try {
      const token = window.localStorage.getItem('llmwiki_token') || '';
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) throw new Error(apiMessage(result) || '密码修改失败');
      await loadAdminData(token);
      setAuthState('loggedIn');
    } catch (error) {
      setPasswordChangeError(errorMessage(error) || '密码修改失败');
    } finally {
      setPasswordChangeLoading(false);
    }
  };

  const handleLogout = () => {
    window.localStorage.removeItem('llmwiki_token');
    setCurrentUser(null);
    setDbData(null);
    setLoginError('');
    setAuthState('loggedOut');
    setScreen('chat');
    window.history.replaceState({}, '', '/');
  };

  const [screen, setScreen] = useState('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sideCollapsed, toggleSideCollapsed] = useSideCollapsed();
  const [adminTab, setAdminTab] = useState('org');
  const [libraryKbId, setLibraryKbId] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [graphOnlinePreview, setGraphOnlinePreview] = useState<PreviewTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (window.location.pathname.startsWith('/admin')) setScreen('admin');
  }, []);

  const openGraphDocument = (kbId: string, documentId: string, title?: string) => {
    setGraphOnlinePreview({ kbId, docId: documentId, title: title || '原始文档' });
  };
  const openGraphKb = (kbId: string) => {
    setLibraryKbId(kbId);
    setScreen('libs');
  };

  const paletteNav = (target: string, payload?: PaletteNavPayload) => {
    setScreen(target);
    if (payload?.kbId) setLibraryKbId(payload.kbId);
    if (payload?.convId) {
      emitOpenConversation(payload.convId);
    }
  };
  const paletteNewChat = () => {
    setScreen('chat');
    emitNewChat();
  };
  const paletteNewKb = () => {
    setScreen('libs');
    setAdminTab('newkb');
    emitNewKb();
  };
  const paletteUpload = () => {
    setScreen('libs');
    setTimeout(() => emitFocusUpload(), 120);
  };

  useAppHotkeys({
    onTogglePalette: () => setPaletteOpen((v) => !v),
    onToggleSideCollapsed: toggleSideCollapsed,
    onEscape: () => setPaletteOpen(false),
    onHelp: () => setHelpOpen(true),
    onNav: setScreen,
    onNewChat: paletteNewChat,
    paletteOpen,
  });

  const titles: Record<string, { t: string; s: string }> = {
    chat: { t: '对话', s: `你的大脑 · ${appStore.KNOWLEDGE_BASES.length} 个可见知识库` },
    libs: { t: '知识库', s: `${appStore.KNOWLEDGE_BASES.length} 个知识库` },
    graph: { t: '知识图谱', s: '你的知识 · 可见知识关系' },
    personal_settings: { t: '个人设置', s: '对外开放服务凭证 (AppId / AppSecret) 与安全管理' },
    admin: { t: '管理后台', s: '组织 · 人员 · 角色 · 行业库 · 授权 · 模型 · 审计' },
    settings: { t: '系统设置', s: '模型与供应商配置' },
  };

  if (authState === 'checking') return <div style={{ padding: 40, textAlign: "center", color: "#999" }}>正在验证登录状态…</div>;
  if (authState === 'loggedOut') return (
    <LoginScreen
      onSubmit={handleLogin}
      error={loginError}
      loading={loginLoading}
      oidcEnabled={oidcEnabled}
      onOidcLogin={handleOidcLogin}
    />
  );
  if (authState === 'mfaRequired') return (
    <MfaScreen onSubmit={handleMfaLogin} onLogout={handleLogout} error={mfaError} loading={mfaLoading} />
  );
  if (authState === 'mfaSetup') {
    return (
      <MfaSetupScreen
        secret={mfaSetupInfo.secret}
        otpauthUri={mfaSetupInfo.otpauthUri}
        onSubmit={handleMfaSetupVerify}
        onLogout={handleLogout}
        error={mfaError}
        loading={mfaLoading}
      />
    );
  }
  if (authState === 'mustChangePassword') return <PasswordChangeScreen onSubmit={handlePasswordChange} onLogout={handleLogout} error={passwordChangeError} loading={passwordChangeLoading} />;
  if (!dbData) return <div style={{ padding: 40, textAlign: "center", color: "#999" }}>系统正在加载企业数据底座，请稍候...</div>;
  if (dbData.error) return <div style={{ padding: 40, textAlign: "center", color: "#999" }}>企业数据底座暂不可用，请检查 API、数据库和登录状态后重试。</div>;
  const canAdmin = canAccessAdmin(appStore.CAPABILITIES);
  const canSettings = canAccessSettings(appStore.CAPABILITIES);
  const visibleScreen = (screen === 'admin' && !canAdmin) || (screen === 'settings' && !canSettings) ? 'chat' : screen;
  return (
    <div className="app">
      <SideNav
        active={visibleScreen}
        setActive={setScreen}
        user={currentUser}
        onLogout={handleLogout}
        kbCount={appStore.KNOWLEDGE_BASES.length}
        capabilities={appStore.CAPABILITIES}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sideCollapsed}
        onToggleCollapse={toggleSideCollapsed}
      />
      <div className="main">
        <TopBar
          title={titles[visibleScreen]?.t || '百纳'}
          sub={titles[visibleScreen]?.s || ''}
          theme={theme || 'light'}
          onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          collapsed={sideCollapsed}
          onToggleCollapse={toggleSideCollapsed}
        />
        <div className="content">
          {/* 多屏常驻挂载：跨屏切换不丢会话/表单状态 */}
          <div style={{ display: visibleScreen === 'chat' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
            <ChatScreen />
          </div>
          <div style={{ display: visibleScreen === 'libs' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
            <LibrariesScreen active={visibleScreen === 'libs'} initialKbId={libraryKbId} capabilities={appStore.CAPABILITIES} onManageGrant={() => { setAdminTab('grant'); setScreen('admin'); }} />
          </div>
          <div style={{ display: visibleScreen === 'graph' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
            <KnowledgeGraphScreen active={visibleScreen === 'graph'} onOpenDocument={openGraphDocument} onOpenKb={openGraphKb} />
          </div>
          <div style={{ display: visibleScreen === 'personal_settings' ? 'flex' : 'none', flex: 1, minWidth: 0, overflowY: 'auto' }}>
            <PersonalSettingsScreen active={visibleScreen === 'personal_settings'} user={currentUser} apiBaseUrl={API_BASE_URL} apiHeaders={apiHeaders} onNotify={(msg: string) => setToast({ text: msg, undo: null })} />
          </div>
          <div style={{ display: visibleScreen === 'admin' || visibleScreen === 'settings' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
            <AdminScreen initialTab={visibleScreen === 'settings' ? 'model' : visibleScreen === 'admin' ? adminTab : undefined} capabilities={appStore.CAPABILITIES} onOpenGrant={() => { setAdminTab('grant'); setScreen('admin'); }} onManageKb={(kbId: string) => { setLibraryKbId(kbId); setScreen('libs'); }} />
          </div>
        </div>
      </div>
      {toast && (
        <div className="toast">
          <span className="tdot" />
          <span>{typeof toast === 'string' ? toast : toast.text}</span>
          {typeof toast !== 'string' && toast.undo && (
            <button type="button" className="toast-undo" onClick={() => { toast.undo?.fn(); setToast(null); }}>{toast.undo.label}</button>
          )}
        </div>
      )}
      {graphOnlinePreview && <OnlinePreviewModal preview={graphOnlinePreview} onClose={() => setGraphOnlinePreview(null)} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNav={paletteNav}
        onNewChat={paletteNewChat}
        onNewKb={paletteNewKb}
        onUpload={paletteUpload}
        conversations={appStore.CONVERSATIONS}
        knowledgeBases={appStore.KNOWLEDGE_BASES}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export default App;
