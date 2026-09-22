/** Typed wrappers around the document preview HTTP endpoints. */
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { apiMessage } from '@/lib/errors';
import type { CompileTruthPayload, DocDetail, PreviewTarget } from '@/types';

export async function fetchOnlinePreviewConfig(kbId: string, documentId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${documentId}/preview-config`, { headers: apiHeaders() });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiMessage(result) || '在线预览配置加载失败');
  return result;
}

export async function fetchCompileTruth(kbId: string, docId: string): Promise<CompileTruthPayload> {
  const res = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/compile-truth`, { headers: apiHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(apiMessage(json) || `API ${res.status}`);
  return json as CompileTruthPayload;
}

export async function fetchDocDetail(kbId: string, docId: string): Promise<DocDetail> {
  const res = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}`, { headers: apiHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(apiMessage(json) || `API ${res.status}`);
  return json as DocDetail;
}

export async function fetchDocFile(kbId: string, docId: string): Promise<Response> {
  return fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/file`, { headers: apiHeaders() });
}

export async function fetchPdfPreviewBlob(kbId: string, docId: string): Promise<Blob> {
  const res = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/pdf-preview`, { headers: apiHeaders() });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(apiMessage(errJson) || `API ${res.status}`);
  }
  return res.blob();
}

export function resolvePreviewIds(preview: PreviewTarget | null | undefined): { kbId: string; docId: string } {
  const kbId = String(preview?.kbId || preview?.kb || '');
  const docId = String(preview?.docId || preview?.documentId || preview?.id || '');
  return { kbId, docId };
}
