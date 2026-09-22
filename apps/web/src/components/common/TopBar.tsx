import React from 'react';
import { Icon } from '@/components/common/Icon';

export interface TopBarProps {
  title: string;
  sub?: string;
  theme: string;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
  onToggleSidebar: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function TopBar({ title, sub, theme, onToggleTheme, onOpenPalette, onOpenHelp, onToggleSidebar, collapsed = false, onToggleCollapse = () => {} }: TopBarProps) {
  return (
    <div className="topbar">
      <button type="button" className="icon-btn sidebar-toggle-btn" onClick={onToggleSidebar} title="打开主菜单" aria-label="打开主菜单">
        <Icon name="menu" size={18}/>
      </button>
      <button
        type="button"
        className="icon-btn desktop-collapse-btn"
        onClick={onToggleCollapse}
        title={collapsed ? "展开侧边栏 (⌘\\)" : "收起侧边栏 (⌘\\)"}
        aria-label="切换侧边栏"
      >
        <Icon name="sidebar" size={16}/>
      </button>
      <div className="crumb"><b>{title}</b>{sub && <> · <span style={{ color: 'var(--ink-3)' }}>{sub}</span></>}</div>
      <div className="topbar-spacer"/>
      <button className="topbar-search-trigger" onClick={onOpenPalette} title="搜索 / 命令面板 (⌘K)">
        <Icon name="search" size={14}/>
        <span>搜索知识库、文档、命令…</span>
        <span className="kbd">⌘K</span>
      </button>
      <div className="topbar-actions">
        <button className="icon-btn" title={theme === 'dark' ? '切换为亮色模式' : '切换为暗色模式'} aria-label={theme === 'dark' ? '切换为亮色模式' : '切换为暗色模式'} onClick={onToggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16}/></button>
        <button className="icon-btn" title="快捷键与帮助 (?)" onClick={onOpenHelp}><Icon name="help" size={16}/></button>
      </div>
    </div>
  );
}
