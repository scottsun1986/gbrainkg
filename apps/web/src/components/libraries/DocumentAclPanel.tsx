"use client";
import { useEffect, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { API_BASE_URL, apiHeaders } from '@/lib/api';

type Entry = { subjectType: string; subjectId: string; name?: string };
export function DocumentAclPanel({ documentId, title, onClose }: { documentId: string; title: string; onClose: () => void }) {
  const [mode, setMode] = useState<'inherit' | 'restricted'>('restricted');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [subjectType, setSubjectType] = useState('user');
  const [subjectId, setSubjectId] = useState('');
  const [search, setSearch] = useState('');
  const [subjects, setSubjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setLoaded(false); setEntries([]); setError(''); setSubjectId(''); setSubjects([]); setSearch('');
    fetch(`${API_BASE_URL}/api/v1/documents/${documentId}/acl`, { headers: apiHeaders(), signal: controller.signal })
      .then(async response => { const body = await response.json(); if (controller.signal.aborted) return; if (!response.ok) throw new Error(body.message || '权限读取失败'); setMode(body.aclMode); setEntries(body.entries); setLoaded(true); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [documentId]);
  useEffect(() => {
    const controller = new AbortController();
    if (search.trim().length < 2) { setSubjects([]); return; }
    const timer = setTimeout(() => {
      fetch(`${API_BASE_URL}/api/v1/documents/${documentId}/acl-subjects?type=${subjectType}&q=${encodeURIComponent(search)}`, { headers: apiHeaders(), signal: controller.signal })
        .then(async response => { const data = await response.json(); if (controller.signal.aborted) return; if (!response.ok) throw new Error(data.message || '搜索失败'); setSubjects(data); })
        .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [documentId, subjectType, search]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/documents/${documentId}/acl`, {
        method: 'PUT', headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ aclMode: mode, entries: mode === 'inherit' ? [] : entries }),
      });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || '保存失败'); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <Modal title={`文档权限 · ${title}`} onClose={onClose} foot={<button className="btn primary" disabled={busy || !loaded} onClick={save}>保存权限</button>}>
    <label>阅读范围 <select value={mode} disabled={busy || !loaded} onChange={event => { setMode(event.target.value as 'inherit' | 'restricted'); setError(''); }}><option value="inherit">继承知识库权限</option><option value="restricted">仅指定用户、角色或组织</option></select></label>
    <p>{mode === 'inherit' ? '保存后，知识库读者可阅读此文档，原有文档授权将被清除。' : '移除全部授权后，文档仍保持受限；知识库所有者和管理员保留管理所需访问。'}</p>
    {mode === 'restricted' && <>
      {entries.map((entry, index) => <div key={`${entry.subjectType}:${entry.subjectId}`} style={{ display: 'flex', gap: 8, marginBottom: 8 }}><span>{{ user: '用户', role: '角色', org: '组织' }[entry.subjectType] || entry.subjectType} · {entry.name || entry.subjectId}</span><button className="btn" disabled={busy} onClick={() => setEntries(entries.filter((_, i) => i !== index))}>移除</button></div>)}
      <div style={{ display: 'flex', gap: 8 }}><select value={subjectType} onChange={event => { setSubjectType(event.target.value); setSubjectId(''); setSubjects([]); }}><option value="user">用户</option><option value="role">角色</option><option value="org">组织</option></select><input aria-label="搜索授权对象" placeholder="输入至少两个字搜索名称" value={search} onChange={event => { setSearch(event.target.value); setSubjectId(''); setError(''); }} /><select aria-label="选择授权对象" value={subjectId} onChange={event => setSubjectId(event.target.value)}><option value="">选择对象</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select><button className="btn" disabled={busy || !loaded} onClick={() => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId)) { setError('请选择授权对象'); return; }
        if (!entries.some(entry => entry.subjectType === subjectType && entry.subjectId === subjectId)) setEntries([...entries, { subjectType, subjectId, name: subjects.find(s => s.id === subjectId)?.name }]); setSubjectId('');
      }}>添加</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
  </Modal>;
}
