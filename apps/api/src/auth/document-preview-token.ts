import { SetMetadata } from '@nestjs/common';
import { signingSecretFor } from './auth-secret';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DOCUMENT_PREVIEW_TRANSPORT = 'document-preview-transport';
export const DocumentPreviewTransport = () => SetMetadata(DOCUMENT_PREVIEW_TRANSPORT, true);

function previewSecret(): string {
  return signingSecretFor('document preview tokens', 'PREVIEW_TOKEN_SECRET');
}

export function signPreviewPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", previewSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPreviewPayload(token: string): Record<string, any> | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  const expected = createHmac("sha256", previewSecret())
    .update(body)
    .digest("base64url");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload?.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}
