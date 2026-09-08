"use client";

import React, { useState, useEffect } from 'react';
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
}: {
  user: any;
  apiBaseUrl: string;
  apiHeaders: () => Record<string, string>;
  onNotify?: (msg: string, type?: 'success' | 'error' | 'info') => void;
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

  useEffect(() => {
    loadCredentials();
  }, []);

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

  const sampleAppId = credentials.find((c) => c.status === 'active')?.appId || 'app_demo_example';

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
      {/* 头部导航与标题 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>个人设置</h2>
          <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--ink-3)' }}>
            管理对外开放服务接口凭证 (AppId / AppSecret) 及个人账号信息
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-2)', padding: 4, borderRadius: 8 }}>
          <button
            onClick={() => setActiveTab('credentials')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: activeTab === 'credentials' ? '#fff' : 'transparent',
              color: activeTab === 'credentials' ? 'var(--primary)' : 'var(--ink-2)',
              fontWeight: 500,
              cursor: 'pointer',
              boxShadow: activeTab === 'credentials' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="key" size={14} />
            <span>API 凭证 (OpenAPI)</span>
          </button>
          <button
            onClick={() => setActiveTab('security')}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: activeTab === 'security' ? '#fff' : 'transparent',
              color: activeTab === 'security' ? 'var(--primary)' : 'var(--ink-2)',
              fontWeight: 500,
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
              color: activeTab === 'docs' ? 'var(--primary)' : 'var(--ink-2)',
              fontWeight: 500,
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
                <Icon name="spark" size={16} color="var(--primary)" />
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>快速测试调用 (cURL 示例)</span>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  copyToClipboard(
                    `curl -X POST ${apiBaseUrl}/open-api/v1/chat/completions \\\n  -H "X-App-Id: ${sampleAppId}" \\\n  -H "X-App-Secret: YOUR_APP_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "你好，请介绍一下知识库内容"}'`,
                    'cURL 示例',
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
              {`curl -X POST ${apiBaseUrl}/open-api/v1/chat/completions \\
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
