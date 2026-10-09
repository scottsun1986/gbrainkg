"use client";
import React from 'react';

/**
 * 文件格式图标：圆角色块 + 格式标记文字。
 * 配色对齐办公格式的通用品牌色（PDF 红 / Word 蓝 / Excel 绿 / PPT 橙 / Markdown 深灰），
 * 标记文字保证不依赖颜色也能区分格式（无障碍）。
 */
interface FtMeta { label: string; color: string; fs: number }

const FILE_TYPES: Record<string, FtMeta> = {
  pdf: { label: 'PDF', color: '#D93025', fs: 7.5 },
  word: { label: 'W', color: '#185ABD', fs: 12 },
  excel: { label: 'X', color: '#107C41', fs: 12 },
  csv: { label: 'CSV', color: '#107C41', fs: 7 },
  ppt: { label: 'PPT', color: '#D9502A', fs: 7.5 },
  md: { label: 'M↓', color: '#3B4757', fs: 9.5 },
  txt: { label: 'TXT', color: '#64748B', fs: 7 },
  zip: { label: 'ZIP', color: '#7C5CD6', fs: 7.5 },
  html: { label: 'H', color: '#0D9488', fs: 11 },
  img: { label: 'IMG', color: '#0EA5E9', fs: 7 },
  file: { label: 'FILE', color: '#94A3B8', fs: 6.5 },
};

function resolveFileType(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (!e) return 'file';
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'rtf', 'odt', 'pages'].includes(e)) return 'word';
  if (['xls', 'xlsx', 'xlsm', 'xlsb'].includes(e)) return 'excel';
  if (['csv', 'tsv'].includes(e)) return 'csv';
  if (['ppt', 'pptx', 'key'].includes(e)) return 'ppt';
  if (['md', 'markdown', 'mdx'].includes(e)) return 'md';
  if (['txt', 'log', 'text'].includes(e)) return 'txt';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return 'zip';
  if (['htm', 'html'].includes(e)) return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic'].includes(e)) return 'img';
  return 'file';
}

export function FileTypeIcon({ type, size = 28, className }: { type?: string; size?: number; className?: string }) {
  const meta = FILE_TYPES[resolveFileType(type || '')] || FILE_TYPES.file;
  return (
    <span
      className={`ft-icon ${className || ''}`}
      style={{ width: size, height: size, background: meta.color, fontSize: meta.fs }}
      title={(type || 'file').toUpperCase()}
      aria-hidden="true"
    >
      {meta.label}
    </span>
  );
}
