"use client";
import React, { useState, useEffect } from 'react';
import { Icon } from '@/components/common/Icon';
import { PaginationBar } from '@/components/common/PaginationBar';
import { asRecord, asArray, errorMessage, apiMessage } from '@/lib/errors';
import type { Pagination } from '@/types';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';

/**
 * System status telemetry is a server-defined nested JSON document whose
 * schema is still evolving.  `StatusNode` keeps property access ergonomic
 * without sprinkling `as any` across the render tree.
 */
type StatusNode = { [key: string]: any };

export function SystemStatusPanel({ capabilities = [] }: { capabilities?: string[] }){
  const [data, setData] = useState<StatusNode | null>(appStore.SYSTEM_STATUS as StatusNode | null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('kbs');
  const [retryingDocId, setRetryingDocId] = useState<string | null>(null);
  const [sectionPages, setSectionPages] = useState<Record<string, number>>({});

  const fetchTelemetry = async (section: string = '', page: number = 1) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (section) { query.set('section', section); query.set('page', String(page)); }
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/system/status-telemetry?${query.toString()}`, {
        headers: apiHeaders()
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        appStore.SYSTEM_STATUS = json;
      }
    } catch (e) {
      console.error('Failed to load status telemetry:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadSectionPage = (section: string, page: number) => {
    setSectionPages((current) => ({ ...current, [section]: page }));
    void fetchTelemetry(section, page);
  };

  useEffect(() => {
    if (!data) fetchTelemetry();
  }, []);

  const s = (data?.summary || {}) as StatusNode;
  const inq = (data?.ingestionQuality || {}) as StatusNode;
  const gbs = (data?.gbrainSources || {}) as StatusNode;
  const scp = (data?.scopeBrainQuality || {}) as StatusNode;
  const drm = (data?.dreamMaintenance || {}) as StatusNode;
  const obx = (data?.outboxAndQueues || {}) as StatusNode;
  const rag = (data?.ragAndModels || {}) as StatusNode;

  const fmt = (val: unknown) => val ? new Date(String(val)).toLocaleString('zh-CN') : '—';
  const statusLabels: Record<string, string> = { completed: '已完成', partial: '部分完成', failed: '失败', running: '执行中', healthy: '运行健康', degraded: '部分降级', warning: '存在告警' };
  const statusColors: Record<string, string> = { completed: 'var(--green)', healthy: 'var(--green)', partial: 'var(--amber)', degraded: 'var(--amber)', failed: 'var(--red)', warning: 'var(--red)', running: 'var(--blue)' };

  const triggerMaintenance = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/brain/maintenance`, { method: 'POST', headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '维护任务提交失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: 'Dream Cycle 维护任务已进入后台队列' }));
      setTimeout(fetchTelemetry, 2000);
    } catch (err) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(err) || '维护任务提交失败' }));
    }
  };

  const retryDoc = async (kbId: string, docId: string) => {
    setRetryingDocId(docId);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/retry`, { method: 'POST', headers: apiHeaders() });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: '已重新触发解析任务' }));
        setTimeout(fetchTelemetry, 2500);
      } else {
        const err = await res.json().catch(() => ({}));
        window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(err) || '重试失败' }));
      }
    } catch (e) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '重试网络异常' }));
    } finally {
      setRetryingDocId(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <div className="h1">系统运行状态与全流程质量监控</div>
          <div className="subline">端到端全链路质量监控 · 百纳知识源与 Scope 脑 · 物理存储 · 向量解析 · 事务 Outbox 队列 · 实时指标遥测</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => fetchTelemetry()} disabled={loading}>
            <Icon name="refresh" size={12}/> {loading ? '刷新中…' : '刷新数据'}
          </button>
          {capabilities?.includes('*') && (
            <button className="btn primary" onClick={triggerMaintenance}>
              <Icon name="refresh" size={12}/> 立即执行 Dream 维护
            </button>
          )}
        </div>
      </div>

      {/* 1. Global Health Status Banner */}
      <div style={{
        background: s.healthStatus === 'healthy' ? 'rgba(16, 185, 129, 0.08)' : s.healthStatus === 'warning' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)',
        border: `1px solid ${s.healthStatus === 'healthy' ? 'rgba(16, 185, 129, 0.3)' : s.healthStatus === 'warning' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
        borderRadius: 10,
        padding: '14px 18px',
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: s.healthStatus === 'healthy' ? 'var(--green)' : s.healthStatus === 'warning' ? 'var(--red)' : 'var(--amber)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16
          }}>
            {s.healthStatus === 'healthy' ? '✓' : '!'}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
              全流程系统健康度：{s.healthStatus === 'healthy' ? '运行健康 (Healthy)' : s.healthStatus === 'warning' ? '存在告警 (Warning)' : '部分降级 (Degraded)'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
              文档解析率 <b>{inq.parseSuccessRate ?? 100}%</b> · Docling Worker <b>{s.doclingStatus?.online ? `在线 (${s.doclingStatus?.latencyMs}ms)` : '离线'}</b> · 物理仓库 <b>{s.storageUsage?.repoFormatted || '—'}</b> · Outbox <b>{s.outboxStatus?.pending || 0} 积压</b>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11.5 }}>
          <span className="badge ok" style={{ padding: '3px 8px' }}>百纳 0.47 核心引擎</span>
          <span className="badge" style={{ padding: '3px 8px', background: 'var(--surface)', color: 'var(--ink)' }}>双级 Dream 自愈就绪</span>
        </div>
      </div>

      {/* 2. 6 Core Quality KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>📄 知识文档与解析</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{inq.totalDocuments || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>篇</span></div>
          <div style={{ fontSize: 11, color: inq.failedDocuments ? 'var(--red)' : 'var(--green)', marginTop: 4 }}>
            {inq.publishedDocuments || 0} 篇已发布 · {inq.failedDocuments || 0} 失败
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>物理切片与向量</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{inq.totalChunks || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>切片</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            均长 {inq.avgChunkLength || 0} 字符 · {inq.embeddingDimensions || 1024} 维
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>🗄️ 百纳 物理知识源</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{gbs.sourcesCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>个 Source</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            磁盘占用 {s.storageUsage?.repoFormatted || '—'}
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>权限 Scope 脑</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{scp.scopesCount || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>个 Scope</span></div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            {scp.derivedPagesCount || 0} 篇派生资产 · 100% 溯源
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>双级 Dream 周期</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{drm.durationsAvgSec ? `${drm.durationsAvgSec}s` : '30s'} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>均耗时</span></div>
          <div style={{ fontSize: 11, color: drm.health === 'healthy' ? 'var(--green)' : 'var(--amber)', marginTop: 4 }}>
            每日 {drm.cron || '02:00'} 执行 · {drm.health === 'healthy' ? '状态良好' : '部分降级'}
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>事务 Outbox 总线</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{obx.outboxCounts?.completed || 0} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>/ {obx.outboxCounts?.total || 0} 完成</span></div>
          <div style={{ fontSize: 11, color: obx.outboxCounts?.pending ? 'var(--amber)' : 'var(--green)', marginTop: 4 }}>
            {obx.outboxCounts?.pending || 0} 待处理 · {obx.outboxCounts?.failed || 0} 失败
          </div>
        </div>
      </div>

      {/* 3. Knowledge Pipeline Lifecycle Stage Visual Tracker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>
          知识流转全生命周期质量链路
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>1. 文档摄入解析</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>Docling {s.doclingStatus?.latencyMs || 0}ms</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{inq.totalDocuments || 0} 份文档已解析</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Docx / PPT / PDF 多格式支持</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>2. 物理切片与向量</span>
              <span className="badge" style={{ fontSize: 9.5 }}>1024 维 BGE</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{inq.totalChunks || 0} 切片 (均长 {inq.avgChunkLength || 0} 字)</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>语义完整性自适应切分</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>3. 百纳 物理源物化</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>Git 底座</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{gbs.sourcesCount || 0} 个 Source 仓库</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>{s.storageUsage?.repoFormatted || '—'} 物理磁盘空间</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>4. Scope 脑与派生层</span>
              <span className="badge purple" style={{ fontSize: 9.5 }}>Derived 100% 溯源</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{scp.scopesCount || 0} Scope / {scp.derivedPagesCount || 0} 派生页</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Eager + Lazy 懒编译混合</div>
          </div>

          <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
              <span>5. 检索重排与问答</span>
              <span className="badge ok" style={{ fontSize: 9.5 }}>0s 权限断流</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{rag.totalConversations || 0} 会话 / {rag.totalMessages || 0} 消息</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 2 }}>Cross-Encoder 精准重排</div>
          </div>
        </div>
      </div>

      {/* 4. Sub-Navigation Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', gap: 18, marginBottom: 16 }}>
        {[
          { k: 'kbs', l: '知识库与切片解析质量' },
          { k: 'sources', l: '百纳知识源与 Scope 脑' },
          { k: 'dream', l: '双级 Dream 维护记录' },
          { k: 'outbox', l: 'Outbox 事件总线与队列' },
          { k: 'models', l: '问答检索与模型网关' },
        ].map(t => (
          <button
            key={t.k}
            onClick={() => {
              setActiveTab(t.k);
              if ((sectionPages[t.k] || 1) > 1) void fetchTelemetry(t.k, sectionPages[t.k]);
            }}
            style={{
              padding: '8px 4px',
              border: 'none',
              background: 'transparent',
              fontSize: 13,
              fontWeight: activeTab === t.k ? 600 : 400,
              color: activeTab === t.k ? 'var(--ink)' : 'var(--ink-3)',
              borderBottom: activeTab === t.k ? '2px solid var(--ink)' : '2px solid transparent',
              cursor: 'pointer'
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      {/* 5. Detailed Breakdown Sub-Panels */}
      {activeTab === 'kbs' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>知识库名称</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 100 }}>文档数量</th>
                <th style={{ width: 100 }}>切片总数</th>
                <th style={{ width: 100 }}>解析状态</th>
                <th style={{ width: 100, textAlign: 'right' }}>健康度</th>
              </tr>
            </thead>
            <tbody>
              {(inq.kbBreakdown || []).map((kb: any) => (
                <tr key={kb.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{kb.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>ID: {kb.id}</div>
                  </td>
                  <td>
                    <span className="badge" style={{ fontSize: 10.5 }}>
                      {kb.type === 'org' ? '组织库' : kb.type === 'industry' ? '行业库' : '个人库'}
                    </span>
                  </td>
                  <td><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{kb.docsCount} 篇</span></td>
                  <td><span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{kb.chunksCount} 个</span></td>
                  <td>
                    {kb.failedDocsCount > 0 ? (
                      <span className="badge danger" style={{ fontSize: 10.5 }}>{kb.failedDocsCount} 篇失败</span>
                    ) : (
                      <span className="badge ok" style={{ fontSize: 10.5 }}>100% 正常</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ color: kb.failedDocsCount > 0 ? 'var(--red)' : 'var(--green)', fontSize: 12, fontWeight: 500 }}>
                      {kb.failedDocsCount > 0 ? '需排查' : '优良'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {inq.failedDocsList?.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)' }}>
              <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>⚠️ 解析失败文档清单</div>
              {inq.failedDocsList.map((d: any) => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(239, 68, 68, 0.1)' }}>
                  <div>
                    <b>{d.title}</b> ({d.kbName}) - <span style={{ color: 'var(--red)' }}>{d.error}</span>
                  </div>
                  <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => retryDoc(d.kbId, d.id)} disabled={retryingDocId === d.id}>
                    {retryingDocId === d.id ? '重试中…' : '重试解析'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <PaginationBar pagination={inq.pagination?.kbBreakdown as Pagination | undefined} onChange={(page) => loadSectionPage('kbs', page)} label="个知识库" />
          {inq.failedDocsList?.length > 0 && <PaginationBar pagination={inq.pagination?.failedDocs as Pagination | undefined} onChange={(page) => loadSectionPage('failedDocs', page)} label="个失败文档" />}
        </div>
      )}

      {activeTab === 'sources' && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 8 }}>百纳 物理源列表 (Raw Sources)</div>
          <div className="table-wrap" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>Source Key</th>
                  <th style={{ width: 90 }}>类型</th>
                  <th style={{ width: 100 }}>包含文档</th>
                  <th style={{ width: 100 }}>绑定成员</th>
                  <th style={{ width: 160 }}>最近同步时间</th>
                  <th style={{ width: 90, textAlign: 'right' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {(gbs.sourcesList || []).map((s: any) => (
                  <tr key={s.sourceKey}>
                    <td><span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ink)' }}>{s.sourceKey}</span></td>
                    <td><span className={`badge ${s.kind === 'shared' ? 'ok' : 'purple'}`}>{s.kind === 'shared' ? '共享源' : '私密源'}</span></td>
                    <td><b>{s.documentsCount}</b> 篇</td>
                    <td><b>{s.membersCount}</b> 人</td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(s.lastSyncAt)}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--green)', fontSize: 12 }}>活跃</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={gbs.pagination as Pagination | undefined} onChange={(page) => loadSectionPage('sources', page)} label="个 Source" />

          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 8 }}>权限 Scope 脑矩阵与派生智能 (Derived Intelligence)</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Scope 指纹</th>
                  <th style={{ width: 80 }}>策略</th>
                  <th style={{ width: 120 }}>复用成员</th>
                  <th>派生全景综述 (Derived Pages)</th>
                  <th style={{ width: 130 }}>版本 (Epoch)</th>
                  <th style={{ width: 90, textAlign: 'right' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {(scp.scopeList || []).map((sc: any) => (
                  <tr key={sc.id}>
                    <td><span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ink)' }}>{sc.fingerprint}</span></td>
                    <td><span className={`badge ${sc.strategy === 'eager' ? 'ok' : 'purple'}`}>{sc.strategy === 'eager' ? 'Eager' : 'Lazy'}</span></td>
                    <td>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                        {sc.members?.map((m: any) => m.displayName || m.username).join(', ') || `${sc.membersCount} 人`}
                      </div>
                    </td>
                    <td>
                      {sc.derivedPages?.length ? (
                        <div>
                          {sc.derivedPages.map((p: any) => (
                            <div key={p.id} style={{ fontSize: 11.5 }}>
                              <b>{p.title}</b> <span style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>({p.derivedCount} 处溯源锚点)</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--ink-4)', fontSize: 11 }}>未生成派生页 (按需懒生成)</span>
                      )}
                    </td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>ACL v{sc.aclEpoch} · 知识 v{sc.knowledgeEpoch}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--green)', fontSize: 12 }}>运行中</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={scp.pagination as Pagination | undefined} onChange={(page) => loadSectionPage('scopes', page)} label="个 Scope" />
        </>
      )}

      {activeTab === 'dream' && (
        <>
          <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 16, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 4 }}>双级 Dream Cycle 调度策略</div>
            <div>• 执行周期：<b>每日 {drm.cron || '0 2 * * *'} ({drm.timezone || 'Asia/Shanghai'})</b></div>
            <div>• <b>Tier 1 (Source Dream)</b>：单源物理索引深度自愈、切片 Embedding 重整、孤岛脏主题自愈。</div>
            <div>• <b>Tier 2 (Scope Dream)</b>：权限 Scope 脑宏观全景总结合成、概念卡片提炼、derivedFrom 锚点校验。</div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>执行开始时间</th>
                  <th style={{ width: 90 }}>运行状态</th>
                  <th>处理源统计</th>
                  <th style={{ width: 100 }}>待编译主题</th>
                  <th style={{ width: 100, textAlign: 'right' }}>执行耗时</th>
                </tr>
              </thead>
              <tbody>
                {(drm.runs || []).map((r: any) => (
                  <tr key={r.id}>
                    <td><span style={{ fontSize: 12 }}>{fmt(r.startedAt)}</span></td>
                    <td><b style={{ color: statusColors[(r.status as string) || ''] || 'var(--ink)', fontSize: 12 }}>{statusLabels[(r.status as string) || ''] || r.status}</b></td>
                    <td>
                      <span style={{ fontSize: 12 }}>{r.sourcesVisited || 0} 个源 ({r.sourcesSucceeded || 0} 成功, {r.sourcesPartial || 0} 部分)</span>
                      {Array.isArray(r.sourceResults) && r.sourceResults.length > 0 && (
                        <details style={{ marginTop: 5, fontSize: 10.5 }}>
                          <summary style={{ cursor: 'pointer', color: 'var(--ink-3)' }}>查看阶段明细</summary>
                          <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
                            {r.sourceResults.slice(0, 12).map((source: any, index: number) => {
                              const graph = source.graphExtraction || {};
                              const skipped = Array.isArray(source.expectedSkippedPhases) ? source.expectedSkippedPhases.length : 0;
                              return (
                                <div key={`${source.sourceKey || source.source || index}-${index}`} style={{ color: 'var(--ink-3)' }}>
                                  <span style={{ fontFamily: 'monospace' }}>{String(source.sourceKey || source.source || 'source').slice(0, 28)}</span>
                                  {' · '}{statusLabels[(source.status as string) || ''] || source.status || '—'}
                                  {' · 图谱：'}{graph.status === 'completed' ? `${graph.pagesProcessed || 0} 页 / ${graph.linksCreated || 0} links` : graph.status || '—'}
                                  {skipped ? ` · 预期跳过 ${skipped} 阶段` : ''}
                                  {source.failedPhases?.length ? ` · 失败：${source.failedPhases.join(', ')}` : ''}
                                  {source.warningPhases?.length ? ` · 告警：${source.warningPhases.join(', ')}` : ''}
                                </div>
                              );
                            })}
                            {r.sourceResults.length > 12 && <div>其余 {r.sourceResults.length - 12} 个源请查看服务日志。</div>}
                          </div>
                        </details>
                      )}
                    </td>
                    <td><b>{r.queuedTopics || 0}</b> 个</td>
                    <td style={{ textAlign: 'right' }}><span style={{ color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={drm.pagination as Pagination | undefined} onChange={(page) => loadSectionPage('dream', page)} label="次 Dream 运行" />
        </>
      )}

      {activeTab === 'outbox' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>待处理事件 (Pending)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: obx.outboxCounts?.pending ? 'var(--amber)' : 'var(--ink)' }}>{obx.outboxCounts?.pending || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>已完成对账 (Completed)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--green)' }}>{obx.outboxCounts?.completed || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>失败事件 (Failed)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: obx.outboxCounts?.failed ? 'var(--red)' : 'var(--ink-3)' }}>{obx.outboxCounts?.failed || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>BullMQ 活跃队列</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--blue)' }}>{obx.queueJobCounts?.active || 0}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>事件类型</th>
                  <th style={{ width: 80 }}>状态</th>
                  <th>事件载荷 (Payload)</th>
                  <th style={{ width: 150 }}>发生时间</th>
                  <th style={{ width: 150, textAlign: 'right' }}>完成时间</th>
                </tr>
              </thead>
              <tbody>
                {(obx.recentEvents || []).map((e: any) => (
                  <tr key={e.id}>
                    <td>
                      <span className="badge" style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 6px' }}>{e.eventType}</span>
                    </td>
                    <td>
                      <span className={`badge ${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'danger' : 'amber'}`}>
                        {e.status === 'completed' ? '已完成' : e.status === 'failed' ? '失败' : '排队中'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: 11, fontFamily: 'SF Mono,Menlo,Consolas,monospace', color: 'var(--ink-2)' }}>
                        {typeof e.payload === 'object' ? JSON.stringify(e.payload) : String(e.payload)}
                      </span>
                    </td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(e.createdAt)}</span></td>
                    <td style={{ textAlign: 'right' }}><span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{fmt(e.processedAt)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar pagination={obx.pagination as Pagination | undefined} onChange={(page) => loadSectionPage('outbox', page)} label="个事件" />
        </>
      )}

      {activeTab === 'models' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>总会话数</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalConversations || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>累计问答消息</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalMessages || 0}</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>溯源引用生成数</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', marginTop: 4 }}>{rag.totalCitations || 0}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 110 }}>网关类型</th>
                  <th>模型名称</th>
                  <th>供应商</th>
                  <th>接入地址</th>
                  <th style={{ width: 80 }}>默认</th>
                  <th style={{ width: 90, textAlign: 'right' }}>连通测试</th>
                </tr>
              </thead>
              <tbody>
                {(rag.activeModels || []).map((m: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <span className="badge" style={{ fontSize: 10.5 }}>
                        {m.kind === 'llm' ? 'LLM 对话' : m.kind === 'embedding' ? '向量嵌入' : '交叉重排'}
                      </span>
                    </td>
                    <td><b>{m.modelName}</b></td>
                    <td>{m.providerName}</td>
                    <td><span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'monospace' }}>{m.baseUrl}</span></td>
                    <td>{m.isDefault ? <span className="badge ok" style={{ fontSize: 10 }}>默认</span> : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: m.testStatus === 'passed' ? 'var(--green)' : 'var(--amber)', fontSize: 12 }}>
                        {m.testStatus === 'passed' ? '通过' : '未测'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rag.runtime && (
            <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>百纳 实际运行态</div>
              <div style={{ color: 'var(--ink-2)' }}>
                {['llm', 'embedding', 'rerank'].map((kind) => {
                  const route = rag.runtime.routes?.[kind] || {};
                  return <span key={kind} style={{ marginRight: 16 }}>{kind === 'llm' ? 'LLM' : kind === 'embedding' ? 'Embedding' : 'Reranker'}：{route.modelName || '未配置'} {route.injected ? '已注入 百纳' : '未注入'}</span>;
                })}
              </div>
              <div style={{ color: 'var(--ink-3)' }}>连接池 {rag.runtime.gbrain?.poolSize || 2} · Scope Synthesize {rag.runtime.gbrain?.scopeSynthesizeEnabled ? '开启' : '关闭'} · 图谱增量抽取 {rag.runtime.gbrain?.graphExtractEnabled ? '开启' : '关闭'}</div>
            </div>
          )}
        </>
      )}
    </>
  );
}
