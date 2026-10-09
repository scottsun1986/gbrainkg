'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ingestionRequest } from '../../lib/ingestion-ui';
import { asArray, asRecord, errorMessage } from '../../lib/errors';
import { apiHeaders } from '../../lib/api';
import { readPreviewBlob } from '../../lib/preview-limits';
import { emitToast } from '../../lib/app-events';
export interface ParserSourceUnit {
  id: string; kind: string; status: 'completed' | 'processed' | 'failed' | 'skipped'; page?: number; sheet?: string; slide?: number; char_start?: number; char_end?: number; native_text_chars?: number; error?: string; anchor?: string; bbox?: number[]; asset_ids?: string[]; source_kind?: 'native' | 'ocr' | 'visual'; generated_text_chars?: number;
}
export interface ParserMetadata {
  embedded_image_count?: number; ocr_image_count?: number; ocr_words_result_num?: number; ocr_average_confidence?: number; ocr_provider?: string;
  coverage?: { total: number; processed: number; failed: number; skipped: number };
  source_units?: ParserSourceUnit[]; assets?: unknown[]; structured_tables?: unknown[]; native_text_chars?: number; generated_text_chars?: number; warnings?: string[];
  [key: string]: unknown;
}
export function IngestionCoverage({ metadata, kbId, docId, canWrite = false, onRetried, version, versionId }: { metadata?: ParserMetadata; kbId: string; docId: string; canWrite?: boolean; onRetried?: () => void; version?: number; versionId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  if (!metadata) return <p>尚无内容覆盖记录。</p>;
  const units = metadata.source_units || [];
  const coverage = metadata.coverage;
  const failed = units.filter(unit => unit.status === 'failed');
  return <section aria-label="入库内容覆盖" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, marginBottom: 18 }}>
    <p className="field-hint">文档：{docId} · 版本：{version !== undefined ? `v${version}` : '未报告'}{versionId ? ` · ${versionId}` : ''}</p>
    <h4 style={{ margin: '0 0 10px' }}>内容覆盖与来源</h4>
    <p>内容覆盖：{coverage ? `已处理 ${coverage.processed} / ${coverage.total} 单元；失败 ${coverage.failed}，跳过 ${coverage.skipped}` : '当前解析结果未报告覆盖率，不能据此判断完整性'}</p>
    <p>原文提取 {metadata.native_text_chars ?? '未报告'} 字 · 系统生成说明 {metadata.generated_text_chars ?? '未报告'} 字。生成说明单独计量。</p>
    {!!metadata.warnings?.length && <ul>{metadata.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {!!units.length && <details open={!!failed.length}><summary>逐页 / 工作表 / 图片处理范围（{units.length}）</summary><div style={{ maxHeight: 260, overflow: 'auto' }}><table className="data-table"><thead><tr><th>选择</th><th>来源单元</th><th>范围</th><th>状态</th><th>来源</th><th>说明</th></tr></thead><tbody>{units.map((unit, index) => <tr key={`${unit.id}-${index}`}><td>{canWrite && unit.status === 'failed' && <input aria-label={`重试来源单元 ${unit.id}`} type="checkbox" checked={selected.includes(unit.id)} onChange={event => setSelected(value => event.target.checked ? [...value, unit.id] : value.filter(id => id !== unit.id))}/>}</td><td>{unit.kind} · {unit.id}</td><td>{[unit.page !== undefined ? `第 ${unit.page} 页` : '', unit.sheet ? `工作表 ${unit.sheet}` : '', unit.slide !== undefined ? `幻灯片 ${unit.slide}` : '', unit.anchor ? `锚点 ${unit.anchor}` : '', unit.bbox ? `区域 ${unit.bbox.join(', ')}` : '', unit.char_start !== undefined ? `字符 ${unit.char_start}–${unit.char_end ?? '?'}` : ''].filter(Boolean).join(' · ') || '—'}</td><td>{['completed', 'processed'].includes(unit.status) ? '已完成' : unit.status === 'failed' ? '失败' : '已跳过'}</td><td>{unit.source_kind === 'visual' ? '视觉模型派生' : unit.source_kind === 'ocr' ? 'OCR 原文识别' : unit.source_kind === 'native' ? '原生事实' : '未报告'}</td><td>{unit.error || '—'}</td></tr>)}</tbody></table></div></details>}
    {canWrite && !!failed.length && <button className="btn" disabled={busy || !selected.length} onClick={async () => {
      setBusy(true); setError('');
      try { await ingestionRequest(`/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/retry-units`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unitIds: selected }) }); setSelected([]); emitToast('失败来源单元已提交重试，重新打开文档可查看处理结果'); onRetried?.(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>{busy ? '提交中…' : `重试选中失败单元（${selected.length}）`}</button>}
    {error && <p role="alert">{error}</p>}
    {!!metadata.assets?.length && <details><summary>图片 / 派生资产（{metadata.assets.length}）</summary>{metadata.assets.map((value, index) => <AssetEvidence key={index} asset={asRecord(value)} index={index} version={version} />)}</details>}
    {!!metadata.structured_tables?.length && <details><summary>结构化表格（{metadata.structured_tables.length}）</summary>{metadata.structured_tables.map((value, index) => { const table = asRecord(value); const cells = table.cells ? asArray(table.cells) : asArray(table.rows).flatMap(row => asArray(asRecord(row).cells)); return <div key={index}><p>{String(table.sheet || table.name || `表 ${index + 1}`)} · {String(table.range || table.id || '')} · {String(table.row_count ?? table.rows_count ?? asArray(table.rows).length)} 行{table.complete === false ? ' · 未完整覆盖' : ''}{table.artifact_id ? ' · 大表完整事实保存在服务端' : ''}</p>{!!cells.length && <div style={{ maxHeight: 200, overflow: 'auto' }}><table className="data-table"><thead><tr><th>坐标</th><th>类型</th><th>原值 / 显示值</th><th>公式</th><th>公式结果</th><th>合并 / 隐藏</th></tr></thead><tbody>{cells.slice(0, 100).map((value, cellIndex) => { const cell = asRecord(value); return <tr key={cellIndex}><td>{String(cell.coordinate || cell.address || `${cell.row ?? ''},${cell.column ?? ''}`)}</td><td>{String(cell.type || cell.data_type || '')}</td><td>{String(cell.value ?? '')} / {String(cell.display ?? cell.display_value ?? '')}</td><td>{String(cell.formula ?? '')}</td><td>{cell.formula ? cell.cached_available ? String(cell.cached ?? '') : '缺少缓存，未当作零' : '—'}</td><td>{String(cell.merge_anchor ?? cell.merged_range ?? '')}{cell.inherited ? ' · 继承展示值，不参与计算' : ''}{cell.hidden ? ' · 隐藏单元格' : ''}</td></tr>; })}</tbody></table><p>仅展示前 100 个事实单元格，统计由服务端完整授权数据执行。</p></div>}</div>; })}</details>}
  </section>;
}

function AssetEvidence({ asset, index, version }: { asset: Record<string, unknown>; index: number; version?: number }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const path = typeof asset.url === 'string' && asset.url.startsWith('/api/v1/kbs/') ? asset.url : '';
  return <div style={{ margin: '10px 0', borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
    <p>{String(asset.id || asset.filename || `资产 ${index + 1}`)} · {String(asset.mime || asset.kind || '图片')} · 来源版本 {version !== undefined ? `v${version}` : '未报告'}{asset.page ? ` · 第 ${asset.page} 页` : ''}{asset.slide ? ` · 幻灯片 ${asset.slide}` : ''}{asset.anchor ? ` · 锚点 ${asset.anchor}` : ''}{asset.bbox ? ` · 区域 ${JSON.stringify(asset.bbox)}` : ''}</p>
    {asset.relativePath ? <p>同包资源路径：{String(asset.relativePath)}</p> : null}
    {asset.source_kind ? <p>内容来源：{String(asset.source_kind)}（视觉模型说明为派生内容）</p> : null}
    {asset.text ? <details><summary>图片识别 / 派生文字</summary><div style={{ whiteSpace: 'pre-wrap' }}>{String(asset.text)}</div></details> : null}
    {asset.error ? <p role="status">{String(asset.error)}</p> : null}
    {path && !url && <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true); setError(''); const controller = new AbortController(); requestRef.current?.abort(); requestRef.current = controller;
      try { const response = await fetch(path, { headers: apiHeaders(), cache: 'no-store', signal: controller.signal }); if (!response.ok) throw new Error(`资产读取失败 (${response.status})`); const blob = await readPreviewBlob(response); if (!/^image\/(png|jpeg|webp|bmp|tiff|gif)$/i.test(blob.type)) throw new Error('该资产请在原件中查看'); if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob)); } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)); } finally { if (!controller.signal.aborted) setBusy(false); }
    }}>{busy ? '读取中…' : '查看授权原始图片'}</button>}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url && <img alt={String(asset.filename || asset.id || `文档图片 ${index + 1}`)} src={url} style={{ display: 'block', maxWidth: '100%', maxHeight: 420, objectFit: 'contain' }} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
