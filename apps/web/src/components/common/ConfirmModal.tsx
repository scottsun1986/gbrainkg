import React from 'react';
import type { ReactNode } from 'react';
import { Modal } from '@/components/common/Modal';

export interface ConfirmModalProps {
  title: ReactNode;
  msg: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmModal({ title, msg, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <Modal title={title} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn danger" onClick={() => { onConfirm(); onClose(); }}>确认删除</button>
      </>
    }>
      <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{msg}</div>
    </Modal>
  );
}
