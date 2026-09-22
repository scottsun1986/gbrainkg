import React from 'react';
import type { Pagination } from '@/types';

export interface PaginationBarProps {
  pagination?: Pagination | null;
  onChange: (page: number) => void;
  label?: string;
}

export function PaginationBar({ pagination, onChange, label = '记录' }: PaginationBarProps) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const page = pagination.page || 1;
  const totalPages = pagination.totalPages || 1;
  return (
    <div className="pagination-bar" style={{ marginTop: 12 }}>
      <div>共 <span className="pagination-num">{pagination.total || 0}</span> {label}，第 <b>{page}</b> / {totalPages} 页</div>
      <div className="pagination-controls">
        <button className="pagination-btn" disabled={page <= 1} onClick={() => onChange(1)}>首页</button>
        <button className="pagination-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <button className="pagination-btn" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button>
        <button className="pagination-btn" disabled={page >= totalPages} onClick={() => onChange(totalPages)}>末页</button>
      </div>
    </div>
  );
}
