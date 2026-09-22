"use client";
import React from 'react';
import { Icon } from '@/components/common/Icon';
import { PaginationBar } from '@/components/common/PaginationBar';
import type { Pagination } from '@/types';

export interface DreamPhase { status?: string }
export interface DreamSourceResult { phases?: DreamPhase[] }
export interface DreamRun {
  id?: string;
  status?: string;
  startedAt?: string;
  errorMessage?: string;
  sourcesVisited?: number;
  sourcesSucceeded?: number;
  sourcesPartial?: number;
  queuedTopics?: number;
  durationMs?: number;
}
export interface DreamScope {
  id?: string;
  fingerprint?: string;
  strategy?: string;
  membersCount?: number;
  derivedCount?: number;
  aclEpoch?: number | string;
  knowledgeEpoch?: number | string;
  status?: string;
}
export interface DreamTelemetry {
  health?: string;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  derivedPagesCount?: number;
  outboxPendingEvents?: number;
  lastRun?: DreamRun & { sourceResults?: DreamSourceResult[] } | null;
  scopes?: DreamScope[];
  runs?: DreamRun[];
  runsPagination?: Pagination | null;
  sources?: unknown[];
}

export function DreamTelemetryPanel({telemetry, onPageChange}: { telemetry: DreamTelemetry; onPageChange: (page: number) => void }){
  const last = telemetry.lastRun ?? null;
  const statusLabels: Record<string, string> = {completed:'已完成',partial:'部分完成',failed:'失败',running:'执行中',clean:'已完成'};
  const statusColors: Record<string, string> = {completed:'var(--green)',partial:'var(--amber)',failed:'var(--red)',running:'var(--blue)',clean:'var(--green)'};
  const fmt = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '—';
  const latestSources = Array.isArray(last?.sourceResults) ? last.sourceResults : [];
  const skippedPhases = latestSources.reduce((sum, source) => sum + ((source.phases || []).filter(phase => phase.status === 'skipped').length), 0);
  const healthLabels: Record<string, string> = {healthy:'运行正常',degraded:'有告警',stale:'超过预期周期',failed:'最近失败',unknown:'尚无运行记录',disabled:'已停用'};
  const healthColors: Record<string, string> = {healthy:'var(--green)',degraded:'var(--amber)',stale:'var(--amber)',failed:'var(--red)',unknown:'var(--ink-3)',disabled:'var(--ink-3)'};
  const scopes = telemetry.scopes || [];

  return <div style={{marginBottom:20}}>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
      {([
        ['运行状态', (telemetry.health && healthLabels[telemetry.health]) || telemetry.health, (telemetry.health && healthColors[telemetry.health]) || 'var(--ink-3)'],
        ['最近双级 Dream', last ? fmt(last.startedAt) : '—', 'var(--ink)'],
        ['权限 Scope 脑', `${scopes.length} 个复用 Scope`, 'var(--ink)'],
        ['派生智能资产', `${telemetry.derivedPagesCount || 0} 篇全局总结/概念`, 'var(--green)'],
        ['Outbox 待处理', `${telemetry.outboxPendingEvents || 0} 个事件`, telemetry.outboxPendingEvents ? 'var(--amber)' : 'var(--ink-3)'],
      ] as Array<[string, React.ReactNode, string]>).map(([label,value,color])=><div key={label} style={{flex:'1 1 170px',minWidth:140,padding:'12px 14px',border:'1px solid var(--line)',borderRadius:8,background:'var(--surface)'}}>
        <div style={{fontSize:11,color:'var(--ink-3)',marginBottom:6}}>{label}</div><div style={{fontSize:13,fontWeight:600,color}}>{value}</div>
      </div>)}
    </div>

    {/* 权限 Scope 脑拓扑矩阵 */}
    <div style={{border:'1px solid var(--line)',borderRadius:8,overflow:'hidden',background:'var(--surface)',marginBottom:12}}>
      <div style={{padding:'10px 14px',fontSize:12,fontWeight:600,borderBottom:'1px solid var(--line)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Icon name="share" size={14}/> 权限 Scope 脑架构（同权限用户组自动复用）</span>
        <span style={{fontSize:11,color:'var(--ink-3)',fontWeight:400}}>共 {scopes.length} 个运行中 Scope</span>
      </div>
      <div style={{maxHeight:180,overflowY:'auto'}}>
        {scopes.map((s)=><div key={s.id} style={{display:'grid',gridTemplateColumns:'160px 80px 100px 120px 1fr 90px',gap:8,padding:'8px 14px',borderBottom:'1px solid var(--line-2)',fontSize:11.5,alignItems:'center'}}>
          <span style={{fontFamily:'monospace',fontWeight:600,color:'var(--ink)'}} title={s.fingerprint}>Scope: {s.fingerprint}</span>
          <span className={`badge ${s.strategy==='eager'?'ok':'purple'}`} style={{fontSize:10,padding:'1px 5px'}}>{s.strategy==='eager'?'Eager':'Lazy'}</span>
          <span>{s.membersCount} 名成员</span>
          <span>{s.derivedCount} 篇派生页</span>
          <span style={{color:'var(--ink-3)',fontSize:11}}>ACL v{s.aclEpoch} · 知识 v{s.knowledgeEpoch}</span>
          <span className={`status ${s.status==='active'?'published':'failed'}`} style={{textAlign:'right'}}><span className="d"/>{s.status==='active'?'运行中':'待对账'}</span>
        </div>)}
        {!scopes.length && <div style={{padding:16,color:'var(--ink-3)',fontSize:12}}>暂无 Scope 记录，系统对账后会自动生成。</div>}
      </div>
    </div>

    <div style={{padding:'12px 14px',border:'1px solid var(--line)',borderRadius:8,background:'var(--surface-2)',fontSize:12,color:'var(--ink-3)',lineHeight:1.6,marginBottom:12}}>
      <b style={{color:'var(--ink)'}}>双级 Dream 维护架构</b>：{telemetry.enabled ? `已启用，每日 ${telemetry.cron}（${telemetry.timezone || '服务器时区'}）执行` : '已停用'}。
      <b>Tier 1 (Source Dream)</b> 负责单原始源的确定性维护与 Embedding 索引；
      <b>Tier 2 (Scope Dream)</b> 负责用户权限 Scope 内的跨源宏观综合与派生智能维护。
      {last && skippedPhases > 0 && <div style={{marginTop:4}}>百纳 phase 隔离：{skippedPhases} 个按 source 隔离策略跳过（私密 source 不外泄跨权限全局总结）。</div>}
      {last?.errorMessage && <div style={{color:'var(--red)',marginTop:4}}>最近失败：{last.errorMessage}</div>}
    </div>

    <div style={{border:'1px solid var(--line)',borderRadius:8,overflow:'hidden',background:'var(--surface)'}}>
      <div style={{padding:'10px 14px',fontSize:12,fontWeight:600,borderBottom:'1px solid var(--line)'}}>最近 Dream 运行记录</div>
      {(telemetry.runs || []).map((run)=><div key={run.id} style={{display:'grid',gridTemplateColumns:'145px 75px 1fr 120px',gap:10,padding:'9px 14px',borderBottom:'1px solid var(--line)',fontSize:11.5,alignItems:'center'}}>
        <span>{fmt(run.startedAt)}</span><b style={{color:(run.status && statusColors[run.status]) || 'var(--ink)'}}>{(run.status && statusLabels[run.status]) || run.status}</b><span>{run.sourcesVisited || 0} 个 source · {run.sourcesSucceeded || 0} 成功 · {run.sourcesPartial || 0} 部分 · {run.queuedTopics || 0} 个待编译主题</span><span style={{color:'var(--ink-3)'}}>{run.durationMs ? `${Math.round(run.durationMs/1000)} 秒` : '—'}</span>
      </div>)}
      {!telemetry.runs?.length && <div style={{padding:16,color:'var(--ink-3)',fontSize:12}}>暂无 Dream 运行记录。</div>}
      <PaginationBar pagination={telemetry.runsPagination ?? undefined} onChange={onPageChange || (() => {})} label="次 Dream 运行" />
    </div>

    <div style={{marginTop:10,fontSize:11,color:'var(--ink-3)'}}>当前 active source：{(telemetry.sources || []).length} 个 · 权限 Scope 脑：{scopes.length} 个 · 派生智能总结：{telemetry.derivedPagesCount || 0} 篇</div>
  </div>;
}
