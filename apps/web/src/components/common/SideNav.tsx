import React from 'react';
import { Icon } from '@/components/common/Icon';
import { hasCapability, canAccessAdmin, canAccessSettings } from '@/lib/capabilities';
import type { CurrentUser } from '@/types';

export interface SideNavProps {
  active: string;
  setActive: (key: string) => void;
  user?: CurrentUser | null;
  onLogout: () => void;
  kbCount?: number;
  capabilities?: string[];
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function SideNav({
  active, setActive, user, onLogout, kbCount = 0, capabilities = [], open = false, onClose = () => {}, collapsed = false, onToggleCollapse = () => {},
}: SideNavProps) {
  const items = [
    { key: 'chat', label: '对话', icon: 'chat', badge: null as string | null },
    { key: 'libs', label: '知识库', icon: 'book', badge: kbCount ? String(kbCount) : null },
    { key: 'graph', label: '知识图谱', icon: 'share', badge: null as string | null },
  ].filter((item) => hasCapability(item.key === 'chat' ? 'chat.use' : 'kb.read', capabilities));
  const canAdmin = canAccessAdmin(capabilities);
  const canSettings = canAccessSettings(capabilities);
  const handleNav = (key: string) => {
    setActive(key);
    onClose();
  };
  return (
    <>
      {open && <div className="side-backdrop" onClick={onClose} />}
      <aside className={`side ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <span className="brand-mark" title="百纳知识底座">百</span>
          {!collapsed && <span className="brand-name">百纳</span>}
          {!collapsed && <span className="brand-sub">企业级知识库</span>}
          <button type="button" className="side-close-btn" onClick={onClose} title="关闭菜单" aria-label="关闭菜单">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <nav className="nav">
          <div className="nav-section">{collapsed ? '·' : '工作'}</div>
          {items.map((it) => (
            <div key={it.key} className={`nav-item ${active === it.key ? 'active' : ''}`} onClick={() => handleNav(it.key)} title={it.label}>
              <Icon name={it.icon} size={16} className="nav-ic"/>
              <span>{it.label}</span>
              {it.badge && <span className="nav-badge">{it.badge}</span>}
            </div>
          ))}
          <div className="nav-section">{collapsed ? '·' : '个人'}</div>
          <div className={`nav-item ${active === 'personal_settings' ? 'active' : ''}`} onClick={() => handleNav('personal_settings')} title="个人设置">
            <Icon name="key" size={16} className="nav-ic"/>
            <span>个人设置</span>
          </div>
          <div className="nav-section">{collapsed ? '·' : '管理'}</div>
          {canAdmin && <div className={`nav-item ${active === 'admin' ? 'active' : ''}`} onClick={() => handleNav('admin')} title="管理后台">
            <Icon name="shield" size={16} className="nav-ic"/>
            <span>管理后台</span>
          </div>}
          {canSettings && <div className={`nav-item ${active === 'settings' ? 'active' : ''}`} onClick={() => handleNav('settings')} title="系统设置 · 模型、供应商与系统级配置">
            <Icon name="setting" size={16} className="nav-ic"/>
            <span>系统设置</span>
          </div>}
        </nav>
        <div className="side-foot">
          <div className="avatar" onClick={() => handleNav('personal_settings')} style={{ cursor: 'pointer' }} title="点击打开个人设置">{String(user?.username || user?.displayName || '用户').slice(0, 2).toUpperCase()}</div>
          <div className="user-info" onClick={() => handleNav('personal_settings')} style={{ cursor: 'pointer' }} title="点击打开个人设置">
            <div className="user-name">{user?.displayName || user?.username || '当前用户'}</div>
            <div className="user-role">{user?.orgs?.map((item) => item.orgNode?.name).filter(Boolean).join('、') || '未分配组织'} · {user?.roles?.[0]?.role?.name || '普通用户'}</div>
          </div>
          <button
            type="button"
            className="collapse-toggle-btn"
            onClick={onToggleCollapse}
            title={collapsed ? "展开导航栏 (⌘\\)" : "收起导航栏 (⌘\\)"}
            aria-label={collapsed ? "展开导航栏" : "收起导航栏"}
          >
            <Icon name="sidebar" size={15}/>
          </button>
          <button className="logout-btn" onClick={onLogout} title="退出登录" aria-label="退出登录">
            <Icon name="logout" size={14} color="var(--ink-3)"/>
            <span>退出</span>
          </button>
        </div>
      </aside>
    </>
  );
}
