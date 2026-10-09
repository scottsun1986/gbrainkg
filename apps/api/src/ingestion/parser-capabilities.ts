/** Approved upload formats, not the full theoretical AnyDoc format list. */
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.html', '.htm', '.doc', '.docx', '.pdf',
  '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp',
]);
export const ANYDOC_UPLOAD_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.pdf', '.xls', '.xlsx',
]);

/** Approved compressed archive formats for bulk document upload */
export const ARCHIVE_UPLOAD_EXTENSIONS = new Set([
  '.zip', '.tar', '.tar.gz', '.tgz',
]);

export function isArchiveFilename(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz')
  );
}

export const INGESTION_CAPABILITIES = {
  extensions: [...SUPPORTED_UPLOAD_EXTENSIONS, ...ARCHIVE_UPLOAD_EXTENSIONS],
  qaExtensions: ['.csv', '.xlsx', '.xls', '.jsonl'],
  limits: { uploadBytes: 200 * 1024 * 1024, archiveFiles: 500,
    archiveTotalBytes: 100 * 1024 * 1024, archiveFileBytes: 50 * 1024 * 1024,
    ocrBytes: 50 * 1024 * 1024, qaRows: 500, qaBytes: 10 * 1024 * 1024 },
  notes: ['音视频、低频专业格式与宏容器暂不支持', '嵌套压缩包不展开',
    '已有真实正文可以发布；图片识别与覆盖告警单独显示', '公式不执行、不刷新外部链接，缺失缓存不按零处理'],
};
