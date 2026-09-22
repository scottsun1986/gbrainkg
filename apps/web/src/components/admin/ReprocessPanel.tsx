"use client";
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { PaginationBar } from '@/components/common/PaginationBar';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast } from '@/lib/app-events';
import type { Pagination } from '@/types';

export function ReprocessPanel() {
  const [stats, setStats] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Configuration options
  const [optEmbeddings, setOptEmbeddings] = useState(true);
  const [optForceAllEmbeddings, setOptForceAllEmbeddings] = useState(false);
  const [optGraphRag, setOptGraphRag] = useState(true);
  const [optRaptor, setOptRaptor] = useState(true);
  const [optBrainCompile, setOptBrainCompile] = useState(true);
  const [optAlignReadiness, setOptAlignReadiness] = useState(true);
  const [optClearCache, setOptClearCache] = useState(true);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/system/reprocess/status`, { headers: apiHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (data.status) setStatus(data.status);
      if (data.corpusStats) setStats(data.corpusStats);
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(() => {
      fetchStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [status?.logs?.length]);

  const handleStart = async () => {
    setShowConfirm(false);
    setActionLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/system/reprocess/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({
          embeddings: optEmbeddings,
          forceAllEmbeddings: optForceAllEmbeddings,
          graphRag: optGraphRag,
          raptor: optRaptor,
          brainCompile: optBrainCompile,
          alignReadiness: optAlignReadiness,
          clearCache: optClearCache,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '启动重处理任务失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '全系统数据重处理已启动！' }));
      await fetchStatus();
    } catch (err: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(err) || '启动失败' }));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/system/reprocess/cancel`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '取消失败');
      window.dispatchEvent(new CustomEvent('app-toast', { detail: '已请求取消任务' }));
      await fetchStatus();
    } catch (err: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(err) || '取消失败' }));
    }
  };

  const isRunning = !!status?.running;
  const progress = status?.progress || 0;
  const embeddedRatio = stats?.totalChunks
    ? Math.round(((stats.chunksWithEmbedding || 0) / stats.totalChunks) * 100)
    : 100;

  return (
    <div style={{ paddingBottom: 40 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <div className="h1" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>全系统数据重处理与全库对齐</span>
            {isRunning && (
              <span className="tag" style={{ background: 'rgba(245,158,11,0.12)', color: '#d97706', border: '1px solid #d97706' }}>
                ● 正在执行重处理
              </span>
            )}
            {!isRunning && status?.completedAt && (
              <span className="tag" style={{ background: 'rgba(16,185,129,0.12)', color: '#059669', border: '1px solid #059669' }}>
                ✓ 运行就绪
              </span>
            )}
          </div>
          <div className="subline">
            一键解决历史老文档未富集问题：补齐密集向量 (pgvector) · 知识图谱深度抽取 (GraphRAG) · 层次化摘要树 (RAPTOR) · GBrain 大脑全员编译 · 就绪状态对齐 · 清空问答缓存
          </div>
        </div>
        <button
          className="btn"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => { setLoading(true); fetchStatus().finally(() => setLoading(false)); }}
        >
          <Icon name="refresh" size={13} />
          <span>刷新指标</span>
        </button>
      </div>

      {/* Overview Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="file" size={14} color="var(--primary)" />
            <span>文档与向量覆盖率</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>
            {stats ? `${stats.readyDocuments} / ${stats.totalDocuments} 篇就绪` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
            分块向量: {stats ? `${stats.chunksWithEmbedding} / ${stats.totalChunks} (${embeddedRatio}%)` : '—'}
            {stats && stats.chunksMissingEmbedding > 0 && (
              <span style={{ color: '#d97706', marginLeft: 6 }}>
                (缺 {stats.chunksMissingEmbedding} 个)
              </span>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="model" size={14} color="var(--primary)" />
            <span>知识图谱资产 (GraphRAG)</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>
            {stats ? `${stats.totalGraphEntities} 实体 / ${stats.totalGraphRelations} 关系` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
            知识社区: {stats ? `${stats.totalGraphCommunities} 个全局社团` : '—'}
          </div>
        </div>

        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="book" size={14} color="var(--primary)" />
            <span>RAPTOR 层次化摘要树</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>
            {stats ? `${stats.totalRaptorNodes} 个摘要节点` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
            支撑宏观全景与归纳概括检索
          </div>
        </div>

        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="activity" size={14} color="var(--primary)" />
            <span>问答语义缓存</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>
            {stats ? `${stats.semanticCacheCount} 条有效缓存` : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
            重处理时自动清空以防旧数据遮蔽
          </div>
        </div>
      </div>

      {/* Progress & Live Status Box */}
      {(isRunning || status?.currentStep) && (
        <div className="card" style={{ padding: 20, marginBottom: 24, border: isRunning ? '1px solid var(--primary)' : '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>任务执行状态</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>
                {isRunning ? '正在实时处理中...' : status?.error ? '任务出现异常' : '处理完毕'}
              </span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>
              {progress}%
            </div>
          </div>

          {/* Progress Bar */}
          <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden', marginBottom: 12 }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: status?.error ? '#ef4444' : 'var(--primary)',
                transition: 'width 0.4s ease',
              }}
            />
          </div>

          <div style={{ fontSize: 13, color: status?.error ? '#ef4444' : 'var(--ink-2)', marginBottom: 16 }}>
            {status?.currentStep || '准备中...'}
          </div>

          {/* Live Output Log */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6, fontWeight: 500 }}>
              实时执行终端日志：
            </div>
            <div
              ref={logContainerRef}
              style={{
                background: '#0d1117',
                color: '#58a6ff',
                fontFamily: 'SF Mono, Menlo, Consolas, monospace',
                fontSize: 11.5,
                lineHeight: 1.6,
                padding: '12px 14px',
                borderRadius: 6,
                maxHeight: 220,
                overflowY: 'auto',
                border: '1px solid #30363d',
              }}
            >
              {(!status?.logs || status.logs.length === 0) ? (
                <div style={{ color: '#8b949e' }}>暂无日志输出...</div>
              ) : (
                status.logs.map((log: any, idx: number) => (
                  <div key={idx} style={{ color: log.level === 'error' ? '#f85149' : log.level === 'warn' ? '#d29922' : '#c9d1d9' }}>
                    <span style={{ color: '#8b949e', marginRight: 8 }}>[{log.timestamp}]</span>
                    <span style={{ color: log.level === 'error' ? '#f85149' : log.level === 'warn' ? '#d29922' : '#79c0ff', marginRight: 6 }}>
                      [{log.level.toUpperCase()}]
                    </span>
                    <span>{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {isRunning && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="btn"
                style={{ color: '#ef4444', borderColor: '#ef4444' }}
                onClick={handleCancel}
              >
                终止当前重处理任务
              </button>
            </div>
          )}
        </div>
      )}

      {/* Task Configuration Card */}
      <div className="card" style={{ padding: 22, marginBottom: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
            重处理流水线配置
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
            勾选需要对全库执行的数据处理环节。新旧知识库文档将统一经过所选流水线全面处理并对齐。
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 20 }}>
          {/* Option 1: Embedding */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optEmbeddings ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptEmbeddings(!optEmbeddings)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optEmbeddings}
                onChange={(e) => setOptEmbeddings(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                1. 密集向量嵌入补齐 (pgvector)
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              扫描全库分块，为缺少向量的段落计算 BAAI/bge-m3 稠密向量，支撑自适应语义检索与相似度召回。
            </div>
            {optEmbeddings && (
              <div
                style={{ marginTop: 10, paddingLeft: 24, display: 'flex', alignItems: 'center', gap: 8 }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  id="forceAllEmbeddings"
                  checked={optForceAllEmbeddings}
                  onChange={(e) => setOptForceAllEmbeddings(e.target.checked)}
                />
                <label htmlFor="forceAllEmbeddings" style={{ fontSize: 12, color: '#d97706', cursor: 'pointer' }}>
                  强制重新生成所有向量（更换或升级 Embedding 模型时勾选）
                </label>
              </div>
            )}
          </div>

          {/* Option 2: GraphRAG */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optGraphRag ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptGraphRag(!optGraphRag)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optGraphRag}
                onChange={(e) => setOptGraphRag(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                2. 知识图谱深度抽取与社区聚类 (GraphRAG)
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              对历史文档提取实体、层级关系与法规引用，并重新运行全库社区发现算法，生成全局社团摘要。
            </div>
          </div>

          {/* Option 3: RAPTOR */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optRaptor ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptRaptor(!optRaptor)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optRaptor}
                onChange={(e) => setOptRaptor(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                3. RAPTOR 层次化摘要树构建
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              递归聚合生成 Level 0/1/2 层次摘要节点与全局目录树，显著提升多章节对比与宏观概括效果。
            </div>
          </div>

          {/* Option 4: Brain Compile */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optBrainCompile ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptBrainCompile(!optBrainCompile)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optBrainCompile}
                onChange={(e) => setOptBrainCompile(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                4. GBrain 知识源同步与大脑全员编译
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              将全部知识库源映射至底层 gbrain-sources，刷新组织架构权限映射，触发用户 Scope Brain 编译。
            </div>
          </div>

          {/* Option 5: Index Readiness */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optAlignReadiness ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptAlignReadiness(!optAlignReadiness)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optAlignReadiness}
                onChange={(e) => setOptAlignReadiness(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                5. 对齐文档就绪状态 (indexReadiness)
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              统一核查老文档富集覆盖度，将符合标准的文档推进为 ready 状态，使全部文档均可被检索引用。
            </div>
          </div>

          {/* Option 6: Clear Cache */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
              background: optClearCache ? 'var(--card-hover, rgba(0,0,0,0.02))' : 'transparent',
              cursor: 'pointer',
            }}
            onClick={() => setOptClearCache(!optClearCache)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={optClearCache}
                onChange={(e) => setOptClearCache(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
              />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>
                6. 清空问答语义缓存 (Semantic Cache)
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', paddingLeft: 24, lineHeight: 1.5 }}>
              清除过去积累的高相似度问答历史缓存，确保重处理后产生的新向量与图谱关系即刻生效。
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            任务将在后台异步执行，不影响前端正常问答与知识库浏览。
          </div>
          <button
            className="btn primary"
            style={{ padding: '9px 20px', fontSize: 13.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}
            disabled={isRunning || actionLoading || (!optEmbeddings && !optGraphRag && !optRaptor && !optBrainCompile && !optAlignReadiness && !optClearCache)}
            onClick={() => setShowConfirm(true)}
          >
            <Icon name="refresh" size={15} />
            <span>{isRunning ? '正在重处理全库数据...' : '开始全系统数据重处理'}</span>
          </button>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirm && (
        <ConfirmModal
          title="确认开始全系统数据重处理？"
          msg={
            <div style={{ lineHeight: 1.6 }}>
              <p>系统将对全库知识文档依次执行所选的重处理流水线：</p>
              <ul style={{ margin: '8px 0 12px 18px', color: 'var(--ink-2)' }}>
                {optEmbeddings && <li>补齐全库分块密集向量嵌入 {optForceAllEmbeddings ? '（⚠️ 包含强制覆盖已有向量）' : ''}</li>}
                {optGraphRag && <li>深度抽取全库知识图谱实体、关系与社区</li>}
                {optRaptor && <li>构建 RAPTOR 层次化摘要树节点</li>}
                {optBrainCompile && <li>同步 GBrain 底层知识库并触发大脑编译</li>}
                {optAlignReadiness && <li>对齐所有文档 indexReadiness 状态</li>}
                {optClearCache && <li>清空所有旧的问答语义缓存</li>}
              </ul>
              <p style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                根据知识文档规模，处理过程可能需要 1~3 分钟。您可以在页面上实时查看进度和日志。
              </p>
            </div>
          }
          onConfirm={handleStart}
          onClose={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

