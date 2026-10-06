import React, { useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';
import type { ReactNode } from 'react';
import { Modal } from '@/components/common/Modal';

export interface ConfirmModalProps {
  title: ReactNode;
  msg: ReactNode;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** 确认按钮文案；默认“确认删除”。停用等非删除语义必须显式传入，避免误导。 */
  confirmText?: string;
  /** 执行中文案；默认“删除中…”。 */
  busyText?: string;
  /** 失败兜底文案；默认“删除失败，请重试”。 */
  errorText?: string;
}

export function ConfirmModal({ title, msg, onConfirm, onClose, confirmText = '确认删除', busyText = '删除中…', errorText = '删除失败，请重试' }: ConfirmModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const close = () => { if (!pending.current) onClose(); };
  const confirm = async () => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await onConfirm(); onClose(); }
    catch (cause) { setError(errorMessage(cause, errorText)); }
    finally { pending.current = false; setSaving(false); }
  };
  return (
    <Modal title={title} onClose={close} foot={
      <>
        <button className="btn" disabled={saving} onClick={close}>取消</button>
        <button className="btn danger" disabled={saving} onClick={confirm}>{saving ? busyText : confirmText}</button>
      </>
    }>
      {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
      <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{msg}</div>
    </Modal>
  );
}
