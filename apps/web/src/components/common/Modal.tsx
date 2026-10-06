import React, { useEffect } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  foot?: ReactNode;
}

export function Modal({ title, onClose, children, foot }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="x" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}
