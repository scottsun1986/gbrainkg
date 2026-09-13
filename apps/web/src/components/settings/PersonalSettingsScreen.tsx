"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Icon } from '@/components/common/Icon';

interface CredentialItem {
  id: string;
  appId: string;
  name: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  maskedSecret: string;
}

export function PersonalSettingsScreen({
  user,
  apiBaseUrl,
  apiHeaders,
  onNotify,
  active = true,
}: {
  user: any;
  apiBaseUrl: string;
  apiHeaders: () => Record<string, string>;
  onNotify?: (msg: string, type?: 'success' | 'error' | 'info') => void;
  active?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<'credentials' | 'security' | 'docs'>('credentials');
  const [credentials, setCredentials] = useState<CredentialItem[]>([]);
  const [loading, setLoading] = useState(false);

  // New credential modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addAppId, setAddAppId] = useState('');
  const [addName, setAddName] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Success reveal modal (AppSecret shown once)
  const [createdResult, setCreatedResult] = useState<{
    appId: string;
    appSecret: string;
    name?: string;
  } | null>(null);

  // Change password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  const notify = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    if (onNotify) onNotify(msg, type);
    else alert(msg);
  };

  const loadCredentials = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/user/credentials`, {
        headers: apiHeaders(),
      });
      const json = await res.json();
      if (json.code === 200 && Array.isArray(json.data)) {
        setCredentials(json.data);
      } else {
        notify(json.msg || '获取凭证列表失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '网络请求错误', 'error');
    } finally {
      setLoading(false);
    }
  };

  // 多屏常驻挂载下首次可见时才拉取凭证列表，避免启动即发起隐藏请求。
  const hasBeenActiveRef = useRef(false);
  useEffect(() => {
    if (active && !hasBeenActiveRef.current) {
      hasBeenActiveRef.current = true;
      loadCredentials();
    }
  }, [active]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/user/credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...apiHeaders(),
        },
        body: JSON.stringify({
          appId: addAppId.trim() || undefined,
          name: addName.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (json.code === 200 && json.data) {
        setShowAddModal(false);
        setAddAppId('');
        setAddName('');
        setCreatedResult({
          appId: json.data.appId,
          appSecret: json.data.appSecret,
          name: json.data.name,
        });
        loadCredentials();
        notify('凭证生成成功，请妥善保管 AppSecret', 'success');
      } else {
        notify(json.msg || '创建凭证失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '创建凭证出错', 'error');
    } finally {
      setAddLoading(false);
    }
  };

  const handleToggleStatus = async (item: CredentialItem) => {
    const nextStatus = item.status === 'active' ? 'disabled' : 'active';
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/user/credentials/${item.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...apiHeaders(),
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await res.json();
      if (json.code === 200) {
        notify(`凭证已${nextStatus === 'active' ? '启用' : '禁用'}`, 'success');
        loadCredentials();
      } else {
        notify(json.msg || '更新状态失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '更新状态失败', 'error');
    }
  };

  const handleRotateSecret = async (item: CredentialItem) => {
    if (!confirm(`确定要为 AppId "${item.appId}" 重新生成 AppSecret 吗？旧密钥将立即失效！`)) {
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/user/credentials/${item.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...apiHeaders(),
        },
        body: JSON.stringify({ rotateSecret: true }),
      });
      const json = await res.json();
      if (json.code === 200 && json.data?.appSecret) {
        setCreatedResult({
          appId: json.data.appId,
          appSecret: json.data.appSecret,
          name: json.data.name,
        });
        loadCredentials();
        notify('密钥重置成功，请立即保存新密钥', 'success');
      } else {
        notify(json.msg || '重置密钥失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '重置密钥出错', 'error');
    }
  };

  const handleDelete = async (item: CredentialItem) => {
    if (!confirm(`确定要永久删除凭证 "${item.appId}" 吗？该操作不可撤销！`)) {
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/user/credentials/${item.id}`, {
        method: 'DELETE',
        headers: apiHeaders(),
      });
      const json = await res.json();
      if (json.code === 200) {
        notify('凭证已删除', 'success');
        loadCredentials();
      } else {
        notify(json.msg || '删除失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '删除出错', 'error');
    }
  };

  const copyToClipboard = (text: string, label = '内容') => {
    navigator.clipboard.writeText(text);
    notify(`${label}已复制到剪贴板`, 'success');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      notify('新密码长度不能少于 6 位', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      notify('两次输入的新密码不一致', 'error');
      return;
    }
    setPwdLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...apiHeaders(),
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      const json = await res.json();
      if (res.ok && (json.ok || json.code === 200)) {
        notify('密码修改成功', 'success');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        notify(json.message || json.msg || '密码修改失败', 'error');
      }
    } catch (e: any) {
      notify(e.message || '修改密码网络错误', 'error');
    } finally {
      setPwdLoading(false);
    }
  };

  const [mcpFormat, setMcpFormat] = useState<'streamable' | 'cursor_sse' | 'claude' | 'dify'>('streamable');
  const [selectedMcpAppId, setSelectedMcpAppId] = useState<string>('');
  const PRODUCTION_DOMAIN = process.env.NEXT_PUBLIC_MCP_URL?.trim() || 'https://knowledge.5gsailor.com:20080';
  const [domainMode, setDomainMode] = useState<'production' | 'current'>(() => {
    if (typeof window !== 'undefined') {
      const h = window.location.hostname;
      // 本地回环IP调试默认当前地址，其余公网IP或生产环境一律默认生产域名
      if (h === 'localhost' || h === '127.0.0.1') return 'current';
    }
    return 'production';
  });

  const sampleAppId = credentials.find((c) => c.status === 'active')?.appId || 'app_demo_example';
  const effectiveMcpAppId = selectedMcpAppId || sampleAppId;
  const currentOrigin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : (apiBaseUrl || 'http://127.0.0.1:3200');

  // 生产对外服务固定走 https://knowledge.5gsailor.com:20080（nginx 20080 → 80）。
  // NEXT_PUBLIC_MCP_URL 或当前地址若遗漏端口，这里统一归一化补齐，
  // 避免生成连不上的 MCP 配置。
  const normalizeMcpOrigin = (origin: string) => {
    try {
      const url = new URL(origin);
      if (url.hostname === 'knowledge.5gsailor.com' && !url.port) {
        url.port = '20080';
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      return origin;
    }
  };

  const getOrigin = () => {
    if (domainMode === 'production') {
      return normalizeMcpOrigin(PRODUCTION_DOMAIN);
    }
    if (typeof window !== 'undefined' && window.location.origin) return normalizeMcpOrigin(window.location.origin);
    return apiBaseUrl || 'http://127.0.0.1:3202';
  };

  const getMcpJson = (format: 'streamable' | 'cursor_sse' | 'claude' | 'dify', appId: string, secret = 'YOUR_APP_SECRET') => {
    const origin = getOrigin();
    if (format === 'streamable') {
      return JSON.stringify(
        {
          mcpServers: {
            gbrainkg: {
              url: `${origin}/mcp`,
              headers: {
                'X-App-Id': appId,
                'X-App-Secret': secret,
              },
            },
          },
        },
        null,
        2,
      );
    }
    if (format === 'cursor_sse') {
      return JSON.stringify(
        {
          mcpServers: {
            gbrainkg: {
              url: `${origin}/mcp/sse`,
              headers: {
                'X-App-Id': appId,
                'X-App-Secret': secret,
              },
            },
          },
        },
        null,
        2,
      );
    }
    if (format === 'claude') {
      return JSON.stringify(
        {
          mcpServers: {
            gbrainkg: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                `${origin}/mcp`,
                '--header',
                `X-App-Id: ${appId}`,
                '--header',
                `X-App-Secret: ${secret}`,
              ],
            },
          },
        },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        server_url: `${origin}/mcp`,
        transport: 'streamable-http',
        headers: {
          'X-App-Id': appId,
          'X-App-Secret': secret,
        },
      },
      null,
      2,
    );
  };

  const mcpLabels: Record<'streamable' | 'cursor_sse' | 'claude' | 'dify', string> = {
    streamable: 'Streamable HTTP (推荐)',
    cursor_sse: 'Cursor / Windsurf (SSE 长连接)',
    claude: 'Claude Desktop (mcp-remote 桥接)',
    dify: 'Dify / Agent 编排平台',
  };

  return (
    <div className="settings-page">
      {/* 头部导航与标题 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>个人设置</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--ink-3)' }}>
            管理对外开放服务接口凭证 (AppId / AppSecret) 及个人账号信息
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-2)', padding: 4, borderRadius: 8, maxWidth: '100%', overflowX: 'auto' }}>
          <button
            onClick={() => setActiveTab('credentials')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: activeTab === 'credentials' ? '#fff' : 'transparent',
              color: activeTab === 'credentials' ? 'var(--ink)' : 'var(--ink-2)',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: activeTab === 'credentials' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="key" size={14} />
            <span>API 凭证 (OpenAPI / MCP)</span>
          </button>
          <button
            onClick={() => setActiveTab('security')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: activeTab === 'security' ? '#fff' : 'transparent',
              color: activeTab === 'security' ? 'var(--ink)' : 'var(--ink-2)',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: activeTab === 'security' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="user" size={14} />
            <span>账号与安全</span>
          </button>
          <button
            onClick={() => setActiveTab('docs')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: activeTab === 'docs' ? '#fff' : 'transparent',
              color: activeTab === 'docs' ? 'var(--ink)' : 'var(--ink-2)',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: activeTab === 'docs' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="doc" size={14} />
            <span>接口调用说明</span>
          </button>
        </div>
      </div>

      {/* TAB 1: API 凭证管理 */}
      {activeTab === 'credentials' && (
        <div>
          {/* 提示 Banner */}
          <div
            style={{
              background: 'rgba(59, 130, 246, 0.05)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <Icon name="alert" size={18} color="#2563eb" style={{ marginTop: 2 }} />
            <div style={{ fontSize: 13, color: '#1e40af', lineHeight: 1.6 }}>
              <b>对外服务接口鉴权说明：</b>第三方业务系统（如考勤系统、OA、CRM或企业微信机器人）可通过请求头{' '}
              <code style={{ background: '#dbeafe', padding: '1px 5px', borderRadius: 4 }}>X-App-Id</code> 与{' '}
              <code style={{ background: '#dbeafe', padding: '1px 5px', borderRadius: 4 }}>X-App-Secret</code>{' '}
              调用本系统的知识库问答与检索服务。系统将自动以您的员工身份及权限范围响应请求。
            </div>
          </div>

          {/* 凭证列表卡片 */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              overflow: 'hidden',
              boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)' }}>我的 API 凭证</span>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>({credentials.length} 个凭证)</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  onClick={loadCredentials}
                  disabled={loading}
                  style={{ padding: '6px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="refresh" size={13} />
                  <span>刷新</span>
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setShowAddModal(true)}
                  style={{ padding: '6px 14px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="plus" size={13} />
                  <span>新建凭证</span>
                </button>
              </div>
            </div>

            {loading && credentials.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>正在加载凭证信息...</div>
            ) : credentials.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>
                暂无 API 凭证，点击上方“新建凭证”生成您的专属 AppId 和 AppSecret
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)', color: 'var(--ink-2)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '10px 16px' }}>应用标识 (AppId)</th>
                    <th style={{ padding: '10px 16px' }}>用途备注</th>
                    <th style={{ padding: '10px 16px' }}>应用密钥 (AppSecret)</th>
                    <th style={{ padding: '10px 16px' }}>状态</th>
                    <th style={{ padding: '10px 16px' }}>最后调用</th>
                    <th style={{ padding: '10px 16px', textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.map((c) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <code
                            style={{
                              background: 'var(--bg-2)',
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontWeight: 600,
                              fontFamily: 'monospace',
                              color: 'var(--ink)',
                            }}
                          >
                            {c.appId}
                          </code>
                          <button
                            onClick={() => copyToClipboard(c.appId, 'AppId')}
                            title="复制 AppId"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', padding: 2 }}
                          >
                            <Icon name="copy" size={13} />
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px', color: 'var(--ink)' }}>{c.name || '未命名'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ fontFamily: 'monospace', color: 'var(--ink-3)' }}>{c.maskedSecret}</span>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 12,
                            fontSize: 12,
                            fontWeight: 500,
                            background: c.status === 'active' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(156, 163, 175, 0.15)',
                            color: c.status === 'active' ? '#16a34a' : '#6b7280',
                          }}
                        >
                          {c.status === 'active' ? '正常运行' : '已禁用'}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px', color: 'var(--ink-3)', fontSize: 12 }}>
                        {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : '从未使用'}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => {
                              setSelectedMcpAppId(c.appId);
                              copyToClipboard(getMcpJson(mcpFormat, c.appId), `[${c.name || c.appId}] MCP 配置`);
                            }}
                            style={{ padding: '4px 8px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                            title="一键复制该凭证的 MCP 配置 JSON"
                          >
                            <Icon name="copy" size={12} />
                            <span>复制 MCP</span>
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleToggleStatus(c)}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                          >
                            {c.status === 'active' ? '禁用' : '启用'}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleRotateSecret(c)}
                            style={{ padding: '4px 8px', fontSize: 12 }}
                            title="重新生成 AppSecret"
                          >
                            重置密钥
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleDelete(c)}
                            style={{ padding: '4px 8px', fontSize: 12, color: '#dc2626' }}
                            title="删除凭证"
                          >
                            <Icon name="trash" size={13} color="#dc2626" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* MCP 服务配置与一键导出卡片 */}
          <div
            style={{
              marginTop: 24,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '20px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="share" size={16} color="var(--ink)" />
                <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--ink)' }}>Model Context Protocol (MCP) 服务配置</span>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: 'rgba(99, 102, 241, 0.1)',
                    color: '#6366f1',
                    fontWeight: 500,
                  }}
                >
                  Cursor · Windsurf · Claude Desktop · VSCode
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {credentials.length > 0 && (
                  <select
                    value={effectiveMcpAppId}
                    onChange={(e) => setSelectedMcpAppId(e.target.value)}
                    style={{
                      padding: '5px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      fontSize: 12,
                      color: 'var(--ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {credentials.map((c) => (
                      <option key={c.appId} value={c.appId}>
                        绑定凭证: {c.name || c.appId} ({c.appId.slice(0, 14)}...)
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    copyToClipboard(
                      getMcpJson(mcpFormat, effectiveMcpAppId),
                      `${mcpLabels[mcpFormat]} 脚本 JSON`,
                    )
                  }
                  style={{ padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="copy" size={13} />
                  <span>一键复制 MCP 配置脚本 JSON</span>
                </button>
              </div>
            </div>

            <p style={{ margin: '0 0 14px 0', fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>
              本知识库原生提供符合 Anthropic MCP (2024-11-05 标准) 的服务端支持，与 OpenAPI 共享统一的{' '}
              <code style={{ background: 'var(--bg-2)', padding: '1px 5px', borderRadius: 4 }}>X-App-Id</code> 与{' '}
              <code style={{ background: 'var(--bg-2)', padding: '1px 5px', borderRadius: 4 }}>X-App-Secret</code> 鉴权。
              在 Cursor、Claude Desktop 等外部大模型助手配置该脚本后，大模型即可自主调用您权限内的知识检索与智能多跳问答工具。
            </p>

            {/* 格式切换 Tabs 与接入域名配置 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 12,
                flexWrap: 'wrap',
              }}
            >
              {/* Agent 格式 Tabs */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['streamable', 'cursor_sse', 'claude', 'dify'] as const).map((fmt) => {
                  const isActive = mcpFormat === fmt;
                  return (
                    <button
                      key={fmt}
                      onClick={() => setMcpFormat(fmt)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        border: isActive ? '1px solid var(--ink)' : '1px solid var(--line)',
                        background: isActive ? 'var(--ink)' : 'var(--surface-2, #FAF8F3)',
                        color: isActive ? 'var(--on-ink, #ffffff)' : 'var(--ink-2)',
                        fontSize: 12,
                        cursor: 'pointer',
                        fontWeight: isActive ? 600 : 500,
                        boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {mcpLabels[fmt]}
                    </button>
                  );
                })}
              </div>

              {/* 接入地址域名选择器 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  background: 'var(--surface-2, #FAF8F3)',
                  padding: '3px 4px',
                  borderRadius: 6,
                  border: '1px solid var(--line)',
                }}
              >
                <span style={{ color: 'var(--ink-3)', fontSize: 11.5, paddingLeft: 4 }}>服务域名:</span>
                <button
                  type="button"
                  onClick={() => setDomainMode('production')}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 4,
                    border: 'none',
                    background: domainMode === 'production' ? 'var(--ink)' : 'transparent',
                    color: domainMode === 'production' ? 'var(--on-ink, #ffffff)' : 'var(--ink-2)',
                    fontSize: 11.5,
                    fontWeight: domainMode === 'production' ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  title="使用生产规范域名及对外服务端口（https://knowledge.5gsailor.com:20080）"
                >
                  生产域名 (knowledge.5gsailor.com:20080)
                </button>
                <button
                  type="button"
                  onClick={() => setDomainMode('current')}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 4,
                    border: 'none',
                    background: domainMode === 'current' ? 'var(--ink)' : 'transparent',
                    color: domainMode === 'current' ? 'var(--on-ink, #ffffff)' : 'var(--ink-2)',
                    fontSize: 11.5,
                    fontWeight: domainMode === 'current' ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  title={`使用当前服务地址（${currentOrigin}）`}
                >
                  当前地址/IP
                </button>
              </div>
            </div>

            <pre
              style={{
                margin: 0,
                padding: '12px 16px',
                background: 'var(--bg-2)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--ink)',
                fontFamily: 'monospace',
                overflowX: 'auto',
                lineHeight: 1.5,
              }}
            >
              {getMcpJson(mcpFormat, effectiveMcpAppId)}
            </pre>
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-4)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="info" size={12} />
              <span>提示：粘贴至编辑器配置文件后，若密钥字段为 <code>YOUR_APP_SECRET</code>，请填入您创建凭证时保存的 AppSecret。</span>
            </div>
          </div>

          {/* 快速调用示例 */}
          <div
            style={{
              marginTop: 24,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '20px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="spark" size={16} color="var(--ink)" />
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>快速测试调用 (MCP Streamable HTTP / OpenAPI 示例)</span>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  copyToClipboard(
                    `# 1. MCP Streamable HTTP 获取工具列表\ncurl -X POST ${getOrigin()}/mcp \\\n  -H "X-App-Id: ${sampleAppId}" \\\n  -H "X-App-Secret: YOUR_APP_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'\n\n# 2. MCP 上传文档工具 (upload_document)\ncurl -X POST ${getOrigin()}/mcp \\\n  -H "X-App-Id: ${sampleAppId}" \\\n  -H "X-App-Secret: YOUR_APP_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "upload_document", "arguments": {"kb_id": "TARGET_KB_ID", "filename": "example.md", "content": "# 文档标题\\n文档内容..."}}}'`,
                    '调用示例',
                  )
                }
                style={{ padding: '4px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <Icon name="copy" size={12} />
                <span>复制代码</span>
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: '12px 16px',
                background: 'var(--bg-2)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--ink)',
                fontFamily: 'monospace',
                overflowX: 'auto',
                lineHeight: 1.5,
              }}
            >
              {`# 1. MCP Streamable HTTP 协议获取支持的工具列表
curl -X POST ${getOrigin()}/mcp \\
  -H "X-App-Id: ${sampleAppId}" \\
  -H "X-App-Secret: YOUR_APP_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'

# 2. 调用 MCP 知识库上传工具 (upload_document)
curl -X POST ${getOrigin()}/mcp \\
  -H "X-App-Id: ${sampleAppId}" \\
  -H "X-App-Secret: YOUR_APP_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "upload_document", "arguments": {"kb_id": "TARGET_KB_ID", "filename": "example.md", "content": "# 文档标题\\n文档内容..."}}}'

# 3. OpenAPI 传统问答对话
curl -X POST ${getOrigin()}/open-api/v1/chat/completions \\
  -H "X-App-Id: ${sampleAppId}" \\
  -H "X-App-Secret: YOUR_APP_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "你好，请介绍一下知识库内容"}'`}
            </pre>
          </div>
        </div>
      )}

      {/* TAB 2: 账号与安全 */}
      {activeTab === 'security' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* 基本信息卡片 */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>个人基本信息</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
              <div>
                <span style={{ color: 'var(--ink-3)', display: 'inline-block', width: 90 }}>登录账号：</span>
                <b style={{ color: 'var(--ink)' }}>{user?.username || '-'}</b>
              </div>
              <div>
                <span style={{ color: 'var(--ink-3)', display: 'inline-block', width: 90 }}>显示姓名：</span>
                <span style={{ color: 'var(--ink)' }}>{user?.displayName || '-'}</span>
              </div>
              <div>
                <span style={{ color: 'var(--ink-3)', display: 'inline-block', width: 90 }}>电子邮箱：</span>
                <span style={{ color: 'var(--ink)' }}>{user?.email || '-'}</span>
              </div>
              <div>
                <span style={{ color: 'var(--ink-3)', display: 'inline-block', width: 90 }}>所属组织：</span>
                <span style={{ color: 'var(--ink)' }}>
                  {user?.orgs?.map((o: any) => o.orgNode?.name).filter(Boolean).join('、') || '默认组织'}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--ink-3)', display: 'inline-block', width: 90 }}>角色身份：</span>
                <span style={{ color: 'var(--ink)' }}>
                  {user?.roles?.map((r: any) => r.role?.name).filter(Boolean).join('、') || '普通用户'}
                </span>
              </div>
            </div>
          </div>

          {/* 修改密码卡片 */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>修改登录密码</h3>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>当前密码</label>
                <input
                  type="password"
                  className="input"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="请输入当前密码"
                  required
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>新密码 (≥6位)</label>
                <input
                  type="password"
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="请输入新密码"
                  required
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>确认新密码</label>
                <input
                  type="password"
                  className="input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="请再次输入新密码"
                  required
                  style={{ width: '100%' }}
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pwdLoading}
                style={{ marginTop: 8, padding: '8px 16px' }}
              >
                {pwdLoading ? '正在更新...' : '保存新密码'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 3: OpenAPI 接口说明 */}
      {activeTab === 'docs' && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>OpenAPI 开放接口规范与协议</h3>
            <a
              href={`${apiBaseUrl}/open-api/spec.json`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '4px 10px', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Icon name="doc" size={13} />
              <span>查看 OpenAPI 3.0 Spec JSON</span>
            </a>
          </div>

          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.8 }}>
            <p>
              本接口契约完全参考标准 OpenAPI 3.0.3 规范，外部系统对接时请在 HTTP 请求头中传入分配给您的凭证：
            </p>
            <ul style={{ paddingLeft: 20 }}>
              <li>
                <b>X-App-Id</b>：您的应用唯一标识字符串（如 <code>{sampleAppId}</code>）
              </li>
              <li>
                <b>X-App-Secret</b>：由系统生成的 48 位高强度安全密钥
              </li>
            </ul>

            <h4 style={{ margin: '16px 0 8px 0', fontSize: 14, color: 'var(--ink)' }}>核心开放接口清单</h4>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 12px' }}>方法</th>
                  <th style={{ padding: '8px 12px' }}>接口路径</th>
                  <th style={{ padding: '8px 12px' }}>功能描述</th>
                  <th style={{ padding: '8px 12px' }}>响应类型</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>POST</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/v1/chat/completions</code></td>
                  <td style={{ padding: '8px 12px' }}>智能知识库问答（支持 SSE 流式与一次性 JSON）</td>
                  <td style={{ padding: '8px 12px' }}>text/event-stream 或 JSON</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>POST</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/v1/search</code></td>
                  <td style={{ padding: '8px 12px' }}>知识库语义与混合精排检索</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>GET</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/v1/knowledge-bases</code></td>
                  <td style={{ padding: '8px 12px' }}>获取当前凭证有权限访问的知识库列表</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>POST</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/v1/documents/upload</code></td>
                  <td style={{ padding: '8px 12px' }}>上传文件至指定知识库并启动流水线解析入库</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>GET</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/v1/documents/status/{'{docId}'}</code></td>
                  <td style={{ padding: '8px 12px' }}>查询文档解析及入库质检状态</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>GET</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/dict/kb-types</code></td>
                  <td style={{ padding: '8px 12px' }}>查询知识库分类字典</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}><code>GET</code></td>
                  <td style={{ padding: '8px 12px' }}><code>/open-api/user/info</code></td>
                  <td style={{ padding: '8px 12px' }}>获取当前凭证绑定的用户信息与角色组织</td>
                  <td style={{ padding: '8px 12px' }}>JSON (统一 R 结构)</td>
                </tr>
              </tbody>
            </table>

            {/* MCP 协议与工具说明 */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="share" size={16} color="var(--ink)" />
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>Model Context Protocol (MCP) 服务</h3>
                </div>
                <a
                  href={`${apiBaseUrl}/mcp/spec`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: '4px 10px', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Icon name="doc" size={13} />
                  <span>查看 MCP Spec JSON</span>
                </a>
              </div>
              <p style={{ margin: '0 0 12px 0', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                本系统支持 Anthropic MCP 标准（2024-11-05 协议规范），可通过 SSE 长连接或直连 JSON-RPC 2.0 供各类大模型客户端直接调用：
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12, marginBottom: 16 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '8px 12px' }}>工具名称 (Tool Name)</th>
                    <th style={{ padding: '8px 12px' }}>参数说明</th>
                    <th style={{ padding: '8px 12px' }}>功能描述与返回内容</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}><code>search_knowledge</code></td>
                    <td style={{ padding: '8px 12px' }}><code>query</code> (必填), <code>kb_ids</code>, <code>top_k</code></td>
                    <td style={{ padding: '8px 12px' }}>多路召回与混合精排检索，返回高匹配度证据文本、分值与溯源元数据</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}><code>chat_knowledge</code></td>
                    <td style={{ padding: '8px 12px' }}><code>prompt</code> (必填), <code>conversation_id</code>, <code>kb_ids</code></td>
                    <td style={{ padding: '8px 12px' }}>企业知识库智能问答与多跳推理，返回严谨的事实裁决回答与引文出处</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}><code>list_knowledge_bases</code></td>
                    <td style={{ padding: '8px 12px' }}><code>type</code> (可选: personal/org/industry)</td>
                    <td style={{ padding: '8px 12px' }}>列出当前凭证有权限访问的所有知识库及文档统计</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}><code>get_document_status</code></td>
                    <td style={{ padding: '8px 12px' }}><code>doc_id</code> (必填)</td>
                    <td style={{ padding: '8px 12px' }}>查询文档的解析状态、分块数量及解析质检得分</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}><code>get_user_info</code></td>
                    <td style={{ padding: '8px 12px' }}>无参数</td>
                    <td style={{ padding: '8px 12px' }}>查询当前 AppId/AppSecret 绑定的用户信息、所属组织与角色权限</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 新增凭证 Modal */}
      {showAddModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: 'var(--surface)',
              width: 480,
              borderRadius: 8,
              padding: 24,
              boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
            }}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>新建对外服务凭证</h3>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>
                  应用标识 (AppId) <span style={{ color: 'var(--ink-3)' }}>（可选，留空将自动生成）</span>
                </label>
                <input
                  type="text"
                  className="input"
                  value={addAppId}
                  onChange={(e) => setAddAppId(e.target.value)}
                  placeholder="例如：app_attendance_crm，须以 app_ 开头"
                  style={{ width: '100%', fontFamily: 'monospace' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-2)', marginBottom: 4 }}>
                  凭证名称 / 接入系统描述
                </label>
                <input
                  type="text"
                  className="input"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="例如：考勤系统智能问答 / CRM系统联动"
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowAddModal(false)}
                  disabled={addLoading}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={addLoading}>
                  {addLoading ? '正在生成...' : '立即生成凭证'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 凭证创建成功与密钥展示 Modal */}
      {createdResult && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
        >
          <div
            style={{
              background: 'var(--surface)',
              width: 520,
              borderRadius: 8,
              padding: 24,
              boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: '#16a34a' }}>
              <Icon name="check" size={20} color="#16a34a" />
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>凭证生成成功</h3>
            </div>

            <div
              style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: 6,
                padding: '10px 14px',
                marginBottom: 16,
                fontSize: 12,
                color: '#b91c1c',
                lineHeight: 1.5,
              }}
            >
              <b>⚠️ 重要提醒：</b>AppSecret 密钥<b>仅此一次明文展示</b>
              。关闭此窗口后将无法再次查看完整密钥。请立即复制并保存在安全位置！
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <span style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 4 }}>
                  应用标识 (AppId)
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    readOnly
                    value={createdResult.appId}
                    style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'monospace', fontSize: 13 }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={() => copyToClipboard(createdResult.appId, 'AppId')}
                  >
                    复制
                  </button>
                </div>
              </div>

              <div>
                <span style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 4 }}>
                  应用密钥 (AppSecret)
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    readOnly
                    value={createdResult.appSecret}
                    style={{ flex: 1, padding: '8px 12px', background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 6, fontFamily: 'monospace', fontSize: 13, color: '#92400e', fontWeight: 600 }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => copyToClipboard(createdResult.appSecret, 'AppSecret')}
                  >
                    复制 Secret
                  </button>
                </div>
              </div>

              {/* 一键复制包含完整新密钥的 MCP 配置 */}
              <div style={{ marginTop: 6, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', display: 'block', marginBottom: 8 }}>
                  快速配置 AI 编辑器 (自动带入本次生成的完整 AppSecret):
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      copyToClipboard(
                        getMcpJson('streamable', createdResult.appId, createdResult.appSecret),
                        '已填入密钥的 Streamable HTTP MCP JSON',
                      )
                    }
                    style={{ padding: '8px 12px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <Icon name="copy" size={13} />
                    <span>复制 Streamable HTTP (含密钥)</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      copyToClipboard(
                        getMcpJson('claude', createdResult.appId, createdResult.appSecret),
                        '已填入密钥的 Claude Desktop MCP JSON',
                      )
                    }
                    style={{ padding: '8px 12px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <Icon name="copy" size={13} />
                    <span>复制 Claude 配置 (含密钥)</span>
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                className="btn btn-secondary"
                onClick={() => setCreatedResult(null)}
                style={{ padding: '8px 20px' }}
              >
                我已经安全保存好，关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
