/**
 * Canonical document preview URL builder.
 *
 * Historically three different shapes were emitted
 * (`/api/v1/ingestion/documents/:id/preview`, `/api/v1/kbs/:kb/documents/:id/preview`,
 * and a tokenized preview-file URL), and none of the first two actually existed
 * as routes. The single supported, auth-checked entry point is
 * `GET /api/v1/kbs/:kbId/documents/:docId/preview-config`;
 * the frontend uses it to obtain a short-lived preview-file token.
 *
 * All citation/preview producers must use this helper so the contract is
 * consistent across chat, agent/MCP, RAPTOR and inventory responses.
 */
export interface PreviewLocation {
  page?: number | string | null;
  clause?: string | null;
  anchor?: string | null;
}

export function buildDocumentPreviewUrl(
  kbId: string | null | undefined,
  documentId: string | null | undefined,
  location: PreviewLocation = {},
): string | null {
  if (!kbId || !documentId) return null;
  const params = new URLSearchParams();
  if (location.page !== undefined && location.page !== null && `${location.page}`.length > 0) {
    params.set("page", String(location.page));
  }
  if (location.clause) params.set("clause", location.clause);
  if (location.anchor) params.set("anchor", String(location.anchor).slice(0, 60));
  const query = params.toString();
  return `/api/v1/kbs/${kbId}/documents/${documentId}/preview-config${query ? `?${query}` : ""}`;
}
