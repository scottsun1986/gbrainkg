/** Approved upload formats, not the full theoretical AnyDoc format list. */
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.html', '.htm', '.doc', '.docx', '.pdf',
  '.xls', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg',
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
