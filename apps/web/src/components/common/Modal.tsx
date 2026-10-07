import React, { useEffect } from 'react';
import type { ReactNode } from 'react';

export interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  foot?: ReactNode;
  /** 宽版弹窗：用于含穿梭框等需要横向空间的表单。 */
  wide?: boolean;
}

export function Modal({ title, onClose, children, foot, wide }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Close only when the press STARTS on the mask itself. Using click (or a bare
  // mask onClick) closes the dialog when a text-selection drag starts inside an
  // input and ends outside it, because the click's target becomes the mask.
  // Checking the mousedown target keeps selection safe.
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
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
