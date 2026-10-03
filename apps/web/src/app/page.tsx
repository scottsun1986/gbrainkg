"use client";

/*
 * Route / layout shell for the interactive prototype.  Screens live in
 * `src/components/**`, shared helpers in `src/lib/**`, and domain types in
 * `src/types/**`.  Runtime behaviour is covered by the API/e2e checks.
 */
/* eslint-disable */
import React, { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { LoginScreen, PasswordChangeScreen, MfaScreen, MfaSetupScreen } from "@/components/auth/LoginScreens";
import { SideNav } from "@/components/common/SideNav";
import { TopBar } from "@/components/common/TopBar";
import { CommandPalette } from "@/components/common/CommandPalette";
import { HelpOverlay } from "@/components/common/HelpOverlay";
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

// Screens are loaded on first use; the logged-out view does not need chat's
// Markdown renderer or retrieval diagnostics. Mounted screens retain state.
const ScreenLoading = () => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-4, #999)', fontSize: 14 }}>加载中…</div>
);
const ChatScreen = dynamic(() => import("@/components/chat/ChatScreen").then((m) => ({ default: m.ChatScreen })), { ssr: false, loading: ScreenLoading });
const LibrariesScreen = dynamic(() => import("@/components/libraries/LibrariesScreen").then((m) => ({ default: m.LibrariesScreen })), { ssr: false, loading: ScreenLoading });
const KnowledgeGraphScreen = dynamic(() => import("@/components/knowledge-graph/KnowledgeGraphScreen").then((m) => ({ default: m.KnowledgeGraphScreen })), { ssr: false, loading: ScreenLoading });
const PersonalSettingsScreen = dynamic(() => import("@/components/settings/PersonalSettingsScreen").then((m) => ({ default: m.PersonalSettingsScreen })), { ssr: false, loading: ScreenLoading });
const AdminScreen = dynamic(() => import("@/components/admin/AdminScreen").then((m) => ({ default: m.AdminScreen })), { ssr: false, loading: ScreenLoading });
const OnlinePreviewModal = dynamic(() => import("@/components/preview/UniversalDocumentViewer").then((m) => ({ default: m.OnlinePreviewModal })), { ssr: false });

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
    // 先立即切换至 loggedIn，让用户看到主壳；admin 数据在后台异步补齐。
    setAuthState('loggedIn');
    void loadAdminData(token).catch(() => window.dispatchEvent(new CustomEvent('app-toast', { detail: '会话初始化失败，请刷新重试' })));
  }, [loadAdminData]);

  // The OIDC callback carries no credential in the URL. Claim the short-lived
  // result cookie through a same-origin request, then clear the URL marker.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash.includes('=') ? hash : `q=${hash}`);
    const token = params.get('token') || (hash.startsWith('token=') ? hash.slice(6) : '');
    const mfa = params.get('mfa_token') || '';
    const mfaSetup = params.get('mfa_setup_token') || '';
    const ssoError = params.get('sso_error') || '';
    const ssoReady = params.get('sso_ready') === '1';
    if (!token && !mfa && !mfaSetup && !ssoError && !ssoReady) return;
    window.history.replaceState({}, '', '/');
    if (ssoError) {
      setLoginError(decodeURIComponent(ssoError));
      setAuthState('loggedOut');
      return;
    }
    if (ssoReady) {
      void fetch(`${API_BASE_URL}/api/v1/auth/oidc/result`, {
        method: 'POST',
        credentials: 'same-origin',
      }).then(async (response) => {
        if (!response.ok) throw new Error(`SSO result ${response.status}`);
        return response.json() as Promise<{ kind: 'token' | 'mfa' | 'mfaSetup'; token?: string; mfaToken?: string }>;
      }).then(async (result) => {
        if (result.kind === 'token' && result.token) {
          await completeLogin(result.token);
        } else if ((result.kind === 'mfa' || result.kind === 'mfaSetup') && result.mfaToken) {
          setMfaToken(result.mfaToken);
          setAuthState(result.kind === 'mfa' ? 'mfaRequired' : 'mfaSetup');
        } else {
          throw new Error('Invalid SSO result');
        }
      }).catch(() => {
        setLoginError('SSO 登录失败，请重试');
        setAuthState('loggedOut');
      });
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

  // ---------- 页面加载时自动校验 localStorage 中的 token ----------
  const [authRetry, setAuthRetry] = useState(false);
  const authTimedOutRef = useRef(false);

  useEffect(() => {
    const token = window.localStorage.getItem('llmwiki_token');
    if (!token) {
      setAuthState('loggedOut');
      return;
    }
    // 刷新链路不再先串行打 auth/me：session/bootstrap 本身就校验 token、返回
    // 会话用户与能力/知识库/会话列表，一次请求完成首屏数据获取。403（如强制
    // 改密）时回退 auth/me 判定原因。超时不再静默清除 token，展示重试按钮。
    authTimedOutRef.current = false;
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      authTimedOutRef.current = true;
      setAuthRetry(true);
      setAuthState('loggedOut');
    }, 15000);
    void (async () => {
      try {
        const sessionUser = await loadAdminData(token);
        if (cancelled || authTimedOutRef.current) return;
        clearTimeout(timeoutId);
        if (sessionUser?.mustChangePassword) {
          setAuthState('mustChangePassword');
          return;
        }
        setAuthState('loggedIn');
      } catch (error) {
        if (cancelled || authTimedOutRef.current) return;
        clearTimeout(timeoutId);
        const status = (error as { status?: number })?.status;
        if (status === 403) {
          // bootstrap 被权限门禁拦截：用 auth/me 判定是否为强制改密。
          try {
            const meRes = await fetch(`${API_BASE_URL}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
            const me = await meRes.json().catch(() => ({} as Record<string, unknown>));
            if ((me as { user?: { mustChangePassword?: boolean } })?.user?.mustChangePassword) {
              setAuthState('mustChangePassword');
              return;
            }
          } catch {}
        }
        if (status !== 401 && status !== 403) {
          setAuthRetry(true);
          setAuthState('loggedOut');
          return;
        }
        window.localStorage.removeItem('llmwiki_token');
        setAuthState('loggedOut');
      }
    })();
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [loadAdminData]);

  useEffect(() => {
    // 管理端连续小操作（保存角色/删模型等）都会广播 app-data-refresh；
    // 去抖合并 250ms 内的多次广播，避免每次都全量重拉 admin/data + conversations。
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const token = window.localStorage.getItem('llmwiki_token');
        if (token) void loadAdminData(token).catch(() => window.dispatchEvent(new CustomEvent('app-toast', { detail: '数据刷新失败，请稍后重试' })));
      }, 250);
    };
    window.addEventListener('app-data-refresh', refresh);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('app-data-refresh', refresh);
    };
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
  // 屏幕懒挂载：默认只挂对话屏，其余屏幕首次切入才挂载（chunk 与数据按需
  // 加载）；挂载后常驻，跨屏切换仍不丢会话/表单状态。
  const [mountedScreens, setMountedScreens] = useState<Set<string>>(() => new Set(['chat']));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sideCollapsed, toggleSideCollapsed] = useSideCollapsed();
  const [adminTab, setAdminTab] = useState('org');
  const [libraryKbId, setLibraryKbId] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [graphOnlinePreview, setGraphOnlinePreview] = useState<PreviewTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const canAdmin = canAccessAdmin(appStore.CAPABILITIES);
  const canSettings = canAccessSettings(appStore.CAPABILITIES);
  const visibleScreen = (screen === 'admin' && !canAdmin) || (screen === 'settings' && !canSettings) ? 'chat' : screen;
  useEffect(() => {
    setMountedScreens((prev) => (prev.has(visibleScreen) ? prev : new Set([...prev, visibleScreen])));
  }, [visibleScreen]);

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
    <>
      {authRetry && (
        <div style={{ padding: '12px 24px', textAlign: 'center', background: 'var(--warning-bg, #fff8e1)', color: 'var(--warning-fg, #e65100)', fontSize: 13, borderBottom: '1px solid var(--warning-border, #ffe0b2)' }}>
          服务器暂未响应，已保留你的登录凭证。
          <button
            type="button"
            style={{ marginLeft: 12, padding: '4px 16px', border: '1px solid currentColor', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 }}
            onClick={() => { setAuthRetry(false); setAuthState('checking'); window.location.reload(); }}
          >
            重试
          </button>
        </div>
      )}
      <LoginScreen
        onSubmit={handleLogin}
        error={loginError}
        loading={loginLoading}
        oidcEnabled={oidcEnabled}
        onOidcLogin={handleOidcLogin}
      />
    </>
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
  if (!dbData) return <div style={{ padding: 40, textAlign: "center", color: "#999" }}><div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>正在加载企业数据，请稍候…</div>;
  if (dbData.error) return <div style={{ padding: 40, textAlign: "center", color: "#999" }}>企业数据底座暂不可用，请检查 API、数据库和登录状态后重试。</div>;
  const adminActive = visibleScreen === 'admin' || visibleScreen === 'settings';
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
          {/* 常驻挂载已访问过的屏幕：跨屏切换不丢会话/表单状态；
              未访问过的屏幕不挂载、代码分包按需加载。 */}
          <div style={{ display: visibleScreen === 'chat' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
            <ChatScreen />
          </div>
          {mountedScreens.has('libs') && (
            <div style={{ display: visibleScreen === 'libs' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
              <LibrariesScreen active={visibleScreen === 'libs'} initialKbId={libraryKbId} capabilities={appStore.CAPABILITIES} onManageGrant={() => { setAdminTab('grant'); setScreen('admin'); }} />
            </div>
          )}
          {mountedScreens.has('graph') && (
            <div style={{ display: visibleScreen === 'graph' ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
              <KnowledgeGraphScreen active={visibleScreen === 'graph'} onOpenDocument={openGraphDocument} onOpenKb={openGraphKb} />
            </div>
          )}
          {mountedScreens.has('personal_settings') && (
            <div style={{ display: visibleScreen === 'personal_settings' ? 'flex' : 'none', flex: 1, minWidth: 0, overflowY: 'auto' }}>
              <PersonalSettingsScreen active={visibleScreen === 'personal_settings'} user={currentUser} apiBaseUrl={API_BASE_URL} apiHeaders={apiHeaders} onNotify={(msg: string) => setToast({ text: msg, undo: null })} />
            </div>
          )}
          {(mountedScreens.has('admin') || mountedScreens.has('settings')) && (
            <div style={{ display: adminActive ? 'flex' : 'none', flex: 1, minWidth: 0 }}>
              <AdminScreen active={adminActive} initialTab={visibleScreen === 'settings' ? 'model' : visibleScreen === 'admin' ? adminTab : undefined} capabilities={appStore.CAPABILITIES} onOpenGrant={() => { setAdminTab('grant'); setScreen('admin'); }} onManageKb={(kbId: string) => { setLibraryKbId(kbId); setScreen('libs'); }} />
            </div>
          )}
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
