/** Approved upload formats, not the full theoretical AnyDoc format list. */
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.html', '.htm', '.doc', '.docx', '.pdf',
  '.xls', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg',
]);
export const ANYDOC_UPLOAD_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.pdf', '.xls', '.xlsx',
]);
