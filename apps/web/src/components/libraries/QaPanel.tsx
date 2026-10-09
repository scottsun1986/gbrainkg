'use client';
import React, { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { emitToast } from '../../lib/app-events';
import { errorMessage } from '../../lib/errors';
import { ingestionRequest, prepareQaRows, qaValue, qaVersions, validateQa, type QaItem, type QaMapping, type QaPreview, type QaRow } from '../../lib/ingestion-ui';

const fields: [keyof QaMapping, string][] = [['question', '标准问题（必选）'], ['answer', '标准答案（必选）'], ['aliases', '相似问题'], ['id', '稳定 ID（更新使用）'], ['scope', '适用范围'], ['language', '语言'], ['effectiveFrom', '生效时间'], ['effectiveTo', '失效时间']];
const emptyRow: QaRow = { question: '', answer: '', aliases: [] };
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function QaPanel({ kbId, canWrite, onChanged }: { kbId: string; canWrite: boolean; onChanged: () => void }) {
  const [items, setItems] = useState<QaItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<QaMapping>({});
  const [preview, setPreview] = useState<QaPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [editor, setEditor] = useState<QaRow | null>(null);
  const [editorIsExisting, setEditorIsExisting] = useState(false);
  const [query, setQuery] = useState('');
  const [approval, setApproval] = useState<{ docId: string; version: number; qa: QaRow } | null>(null);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [tick, setTick] = useState(0);
  const base = `/kbs/${encodeURIComponent(kbId)}/qa`;
  useEffect(() => {
    const controller = new AbortController();
    void ingestionRequest<{ items: QaItem[] }>(base, { signal: controller.signal }).then(data => { setItems(data.items || []); setError(''); }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); });
    return () => controller.abort();
  }, [base, tick]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(errorMessage(err, '操作失败')); } finally { setBusy(false); }
  }
  async function getPreview(input: File, columns: QaMapping) {
    const form = new FormData(); form.append('file', input); form.append('mapping', JSON.stringify(columns));
    const result = await ingestionRequest<QaPreview>(`${base}/preview`, { method: 'POST', body: form });
    setPreview(result); setReviewed(false);
  }
  function template() {
    const rows = [JSON.stringify({ id: 'faq-001', question: '标准问题', answer: '支持完整 Markdown 答案', aliases: ['相似问一', '相似问二'], scope: '', language: 'zh', effectiveFrom: '', effectiveTo: '' }), JSON.stringify({ id: 'faq-zero', question: '零值答案示例', answer: 0, aliases: [] })];
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'application/x-ndjson;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'qa-template.jsonl'; link.click(); URL.revokeObjectURL(url);
  }
  const ready = prepareQaRows(preview?.rows || []);
  const visible = items.filter(item => `${item.title} ${qaVersions(item).displayed?.question || ''} ${(qaVersions(item).displayed?.aliases || []).join(' ')} ${qaVersions(item).active?.question || ''} ${(qaVersions(item).active?.aliases || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <div style={{ padding: 20 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <h3 style={{ margin: 0 }}>标准问答</h3><button className="btn" onClick={template}>下载 JSONL 模板</button>
      {canWrite && <button className="btn" onClick={() => { setEditor({ ...emptyRow }); setEditorIsExisting(false); setReviewed(false); }}>新增问答</button>}
      <button className="btn" disabled={busy} onClick={() => setTick(value => value + 1)}>刷新</button>
    </div>
    <p className="field-hint">一条答案可关联多个相似问。稳定 ID 用于更新同一条问答；默认保存为待审核候选，审核后才进入检索。适用范围、生效时间和失效时间随问答保存。</p>
    {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    {canWrite && <section aria-label="问答文件导入" style={{ border: '1px solid var(--line)', padding: 16, borderRadius: 8, marginBottom: 16 }}>
      <label>导入 CSV / XLS / XLSX / JSONL <input aria-label="选择问答文件" type="file" accept=".csv,.xls,.xlsx,.jsonl" disabled={busy} onChange={event => {
        const input = event.target.files?.[0]; event.target.value = ''; if (!input) return;
        setFile(input); setMapping({}); setPreview(null); void run(() => getPreview(input, {}));
      }}/></label>
      {file && <p>{file.name}</p>}
      {preview && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
          {fields.map(([key, label]) => <div className="field" key={key}><label htmlFor={`qa-map-${key}`}>{label}</label><select id={`qa-map-${key}`} value={mapping[key] ?? ''} disabled={busy} onChange={event => { setMapping(value => ({ ...value, [key]: event.target.value })); setPreview(value => value ? { ...value, rows: [], validCount: 0 } : value); setReviewed(false); }}><option value="">请选择字段</option>{preview.fields.map((name, index) => <option key={`${name}-${index}`} value={name}>{name || `列 ${index + 1}`}</option>)}</select></div>)}
        </div>
        <button className="btn" disabled={busy || !mapping.question || !mapping.answer} onClick={() => file && void run(() => getPreview(file, mapping))}>按映射校验并预览</button>
        {!!preview.warnings?.length && <p role="status">{preview.warnings.join('；')}</p>}
        <p>校验通过 {ready.length} 条 / 总计 {preview.rows.length} 条。冲突与错误项不会导入，请映射已有稳定 ID 明确更新，或调整文件后重新预览。</p>
        {!!preview.errors?.length && <ul role="alert">{preview.errors.map((message, index) => <li key={index}>{typeof message === 'string' ? message : `第 ${message.line} 行：${message.error}`}</li>)}</ul>}
        <div style={{ maxHeight: 320, overflow: 'auto' }}><table className="data-table"><thead><tr><th>行 / ID</th><th>标准问与相似问</th><th>答案</th><th>检查结果</th></tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}><td>{row.line ?? index + 1}<br/>{row.id || '新问答'}</td><td>{row.question}<div className="field-hint">{row.aliases?.join('；')}</div></td><td style={{ whiteSpace: 'pre-wrap', maxWidth: 350 }}>{qaValue(row.answer)}</td><td>{row.conflict ? '答案冲突：请映射已有稳定 ID 明确更新，或修改标准问题' : row.errors?.length ? row.errors.join('；') : '可导入'}</td></tr>)}</tbody></table></div>
        <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewed(event.target.checked)}/>我已逐条审核，确认范围、时效和答案正确，导入后发布</label>
        <button className="btn primary" disabled={busy || !ready.length} onClick={() => void run(async () => {
          await ingestionRequest(`${base}/import`, json({ rows: ready, reviewed })); setPreview(null); setFile(null); setReviewed(false); setTick(value => value + 1); onChanged(); emitToast(reviewed ? '问答已提交审核发布与索引' : '问答已保存为待审核候选');
        })}>{busy ? '处理中…' : reviewed ? `审核并发布 ${ready.length} 条` : `保存 ${ready.length} 条候选`}</button>
      </>}
    </section>}
    <div className="field"><label htmlFor="qa-search">查找标准问题 / 相似问</label><input id="qa-search" value={query} onChange={event => setQuery(event.target.value)}/></div>
    <table className="data-table"><thead><tr><th>问答及发布版本</th><th>状态 / 版本</th><th>展示版本适用范围 / 时效</th><th>操作</th></tr></thead><tbody>{visible.map(item => {
      const view = qaVersions(item);
      const qa = view.displayed;
      return <tr key={item.id}><td><QaVersionContent item={item} /></td><td>{view.pending ? view.state === 'needs_review' ? '候选待审核' : view.state === 'failed' ? '候选处理失败' : '候选索引中' : view.active ? '当前版本已发布' : view.state}<br/>v{view.displayVersion}</td><td>{qa?.scope || '未指定'}<br/>{qa?.language || '未指定语言'}<br/>{qa?.effectiveFrom || '立即生效'} 至 {qa?.effectiveTo || '长期有效'}</td><td>{canWrite && qa && <><button className="btn" disabled={busy} onClick={() => { setEditor({ ...qa }); setEditorIsExisting(true); setReviewed(false); }}>{view.pending ? '编辑候选标准问 / 相似问' : '编辑标准问 / 相似问'}</button>{view.pending && view.pending.reviewStatus !== 'approved' && <button className="btn" disabled={busy} onClick={() => { setApproval({ docId: item.id, version: view.displayVersion, qa: view.pending! }); setApprovalConfirmed(false); }}>审核候选内容</button>}</>}</td></tr>;
    })}</tbody></table>
    {!visible.length && <p className="field-hint">暂无匹配的标准问答。</p>}
    {approval && <Modal wide title="审核待发布候选问答" onClose={() => { if (!busy) setApproval(null); }} foot={<><button className="btn" disabled={busy} onClick={() => setApproval(null)}>取消</button><button className="btn" disabled={busy} onClick={() => { setApproval(null); setTick(value => value + 1); setError(''); }}>重新加载候选</button><button className="btn primary" disabled={busy || !approvalConfirmed} onClick={() => void run(async () => { await ingestionRequest(`${base}/${encodeURIComponent(approval.docId)}/review`, json({ approved: true, expectedVersion: approval.version })); setApproval(null); setTick(value => value + 1); onChanged(); emitToast('问答已审核，后台正在发布与索引'); })}>确认审核并发布</button></>}>
      <QaApprovalContent qa={approval.qa} version={approval.version} /><label><input type="checkbox" checked={approvalConfirmed} onChange={event => setApprovalConfirmed(event.target.checked)}/>我已核对标准答案、范围及有效期，确认发布</label>{error && <p role="alert">{error}</p>}
    </Modal>}
    {editor && <Modal wide title={editor.id ? '更新 / 审核问答' : '新增问答'} onClose={() => { if (!busy) setEditor(null); }} foot={<><button className="btn" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={busy || !!validateQa(editor).length} onClick={() => void run(async () => { await ingestionRequest(`${base}/import`, json({ rows: [editor], reviewed })); setEditor(null); setTick(value => value + 1); onChanged(); emitToast(reviewed ? '已提交问答审核发布' : '已保存候选问答'); })}>{reviewed ? '确认审核并发布' : '保存为待审核候选'}</button></>}>
      <div className="field"><label htmlFor="qa-editor-id">稳定 ID（可选；更新时保持不变）</label><input id="qa-editor-id" readOnly={editorIsExisting} value={editor.id || ''} onChange={event => setEditor({ ...editor, id: event.target.value })}/></div>
      <div className="field"><label htmlFor="qa-editor-question">标准问题</label><input id="qa-editor-question" value={editor.question || ''} onChange={event => setEditor({ ...editor, question: event.target.value })}/></div>
      <div className="field"><label htmlFor="qa-editor-aliases">相似问题（每行一条）</label><textarea id="qa-editor-aliases" rows={3} value={editor.aliases?.join('\n') || ''} onChange={event => setEditor({ ...editor, aliases: event.target.value.split('\n') })}/></div>
      <div className="field"><label htmlFor="qa-editor-answer">标准答案（保留 Markdown）</label><textarea id="qa-editor-answer" rows={8} value={qaValue(editor.answer)} onChange={event => setEditor({ ...editor, answer: event.target.value })}/></div>
      <div className="field"><label htmlFor="qa-editor-scope">适用范围</label><input id="qa-editor-scope" value={editor.scope || ''} onChange={event => setEditor({ ...editor, scope: event.target.value })}/></div>
      <div className="field"><label htmlFor="qa-editor-language">语言</label><input id="qa-editor-language" value={editor.language || ''} onChange={event => setEditor({ ...editor, language: event.target.value })}/></div>
      <div className="field"><label htmlFor="qa-editor-effectiveFrom">生效时间（ISO 8601，可留空）</label><input id="qa-editor-effectiveFrom" placeholder="2026-10-09T00:00:00+08:00" value={editor.effectiveFrom || ''} onChange={event => setEditor({ ...editor, effectiveFrom: event.target.value || undefined })}/></div>
      <div className="field"><label htmlFor="qa-editor-effectiveTo">失效时间（ISO 8601，可留空）</label><input id="qa-editor-effectiveTo" value={editor.effectiveTo || ''} onChange={event => setEditor({ ...editor, effectiveTo: event.target.value || undefined })}/></div>
      {editor.sourceDocumentId && <p className="field-hint">来源文档：{editor.sourceDocumentId} · 来源版本：{editor.sourceVersionId || '未绑定'} · {editor.sourceCategory || 'manual'}</p>}
      <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>我已审核上述标准答案，确认发布</label>
      {!!validateQa(editor).length && <p role="alert">{validateQa(editor).join('；')}</p>}
      {error && <p role="alert">{error}</p>}
    </Modal>}
  </div>;
}

export function QaVersionContent({ item }: { item: QaItem }) {
  const view = qaVersions(item);
  const content = (qa: QaRow) => <><div>{qa.question}</div><div className="field-hint">相似问：{qa.aliases?.join('；') || '无'}</div><div style={{ whiteSpace: 'pre-wrap' }}>{qaValue(qa.answer)}</div><p className="field-hint">适用范围：{qa.scope || '未指定'} · 语言：{qa.language || '未指定'}<br/>生效：{qa.effectiveFrom || '立即'} · 失效：{qa.effectiveTo || '长期有效'}</p></>;
  return <>
    {view.pending && <details open><summary>待发布候选 v{view.displayVersion}</summary>{content(view.pending)}</details>}
    {view.active && <details open={!view.pending}><summary>当前已发布 v{view.activeVersion}</summary>{content(view.active)}</details>}
    {!view.active && view.pending && <p className="field-hint">尚无已发布版本</p>}
    {!view.displayed && <span>{item.title}（问答内容暂不可用）</span>}
  </>;
}

export function QaApprovalContent({ qa, version }: { qa: QaRow; version: number }) {
  return <><h4>{qa.question}</h4><p>相似问：{qa.aliases?.join('；') || '无'}</p><div style={{ whiteSpace: 'pre-wrap' }}>{qaValue(qa.answer)}</div><p className="field-hint">稳定 ID：{qa.id} · 待发布候选版本：v{version}{qa.sourceDocumentId ? ` · 来源文档 ${qa.sourceDocumentId} / 版本 ${qa.sourceVersionId || '未绑定'}` : ''}</p><p>适用范围：{qa.scope || '未指定'} · 语言：{qa.language || '未指定'}</p><p>生效：{qa.effectiveFrom || '立即'} · 失效：{qa.effectiveTo || '长期有效'}</p></>;
}
