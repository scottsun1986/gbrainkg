'use client';
import React, { useEffect, useState } from 'react';
import { ingestionRequest, canRetryImport, type ImportBatch } from '../../lib/ingestion-ui';
import { errorMessage } from '../../lib/errors';
import { emitToast } from '../../lib/app-events';
const labels: Record<string, string> = { accepted: '已受理', reused: '复用已有文档', skipped: '已跳过', failed: '失败', asset: '关联图片资产', parsing: '解析中', indexing: '索引中', published: '已发布', needs_review: '待复核' };
export function ImportBatchPanel({ batches, canWrite, onChanged, onPreview, active = true }: { batches: ImportBatch[]; canWrite: boolean; active?: boolean; onChanged: () => void; onPreview: (docId: string, title: string) => void }) {
  const [selected, setSelected] = useState(batches[0]?.id || '');
  const [manualId, setManualId] = useState('');
  const [batch, setBatch] = useState<ImportBatch | null>(batches[0] || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  useEffect(() => {
    if (!selected || !active) return;
    const controller = new AbortController();
    const load = () => void ingestionRequest<ImportBatch>(`/kbs/imports/${encodeURIComponent(selected)}`, { signal: controller.signal }).then(data => { setBatch(data); setError(''); }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    load(); const timer = setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected, tick, active]);
  async function retry(paths: string[]) {
    setBusy(true); setError('');
    try { await ingestionRequest(`/kbs/imports/${encodeURIComponent(selected)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) }); setChecked([]); setTick(value => value + 1); onChanged(); emitToast('选中条目已提交重试'); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div style={{ padding: 20 }}>
    <h3>压缩包导入清单</h3><p className="field-hint">每个原始路径均保留结果。MD 引用的同包图片会关联为资产；外部图片默认不下载。嵌套压缩包不展开。已跳过或未创建文档的条目请修复后重新上传。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      <select aria-label="导入批次" value={selected} onChange={event => { setSelected(event.target.value); setChecked([]); setBatch(null); }}><option value="">选择本次会话上传的批次</option>{selected && !batches.some(value => value.id === selected) && <option value={selected}>{selected}</option>}{batches.map(value => <option key={value.id} value={value.id}>{value.archiveName} · {value.id}</option>)}</select>
      <input aria-label="历史批次 ID" placeholder="输入历史批次 ID" value={manualId} onChange={event => setManualId(event.target.value)}/><button className="btn" disabled={!manualId.trim()} onClick={() => { setSelected(manualId.trim()); setBatch(null); setChecked([]); }}>查看历史批次</button>
      <button className="btn" disabled={!selected || busy} onClick={() => setTick(value => value + 1)}>刷新</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {batch && <><p>{batch.archiveName} · 批次 ID：<code>{batch.id}</code> · 共 {batch.items.length} 项</p>
      {canWrite && <button className="btn" disabled={busy || !checked.length} onClick={() => void retry(checked)}>重试选中失败项（{checked.length}）</button>}
      <div style={{ overflowX: 'auto' }}><table className="data-table"><thead><tr><th>选择</th><th>原始路径</th><th>处理结果</th><th>说明</th><th>文档</th></tr></thead><tbody>{batch.items.map((item, index) => <tr key={`${item.path}-${index}`}><td>{canWrite && canRetryImport(item) && <input type="checkbox" aria-label={`选择重试 ${item.path}`} checked={checked.includes(item.path)} onChange={event => setChecked(value => event.target.checked ? [...value, item.path] : value.filter(path => path !== item.path))}/>}</td><td>{item.path}{item.hash && <details><summary>内容哈希</summary><code>{item.hash}</code></details>}</td><td>{labels[item.status] || item.status}</td><td>{item.reason || '—'}</td><td>{item.documentId ? <button className="btn" onClick={() => onPreview(item.documentId!, item.path)}>查看文档</button> : '—'}</td></tr>)}</tbody></table></div>
    </>}
    {!selected && <p>上传 ZIP / TAR 后可在这里查看逐项结果，也可通过批次 ID 恢复历史清单。</p>}
  </div>;
}
