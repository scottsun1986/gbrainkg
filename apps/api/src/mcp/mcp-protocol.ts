import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

export const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-11-25'] as const;
export const MCP_CURRENT_PROTOCOL = '2025-11-25';

export function trustedMcpInstanceUrl(): string {
  const configured = process.env.PUBLIC_API_URL || process.env.WEB_ORIGIN?.split(',')[0] || process.env.CORS_ORIGINS?.split(',')[0];
  const value = configured?.trim() || `http://localhost:${Number(process.env.PORT) || 3000}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public instance URL');
  return url.origin + url.pathname.replace(/\/$/, '');
}

export function validateMcpOrigin(req: Request): void {
  const origin = req.headers?.origin;
  if (origin === undefined) return;
  const configured = [...(process.env.WEB_ORIGIN || '').split(','), ...(process.env.CORS_ORIGINS || '').split(',')].map(s => s.trim()).filter(Boolean);
  const allowed = configured.length ? configured : ['http://localhost:3001', 'http://localhost:3200', 'http://127.0.0.1:3200'];
  if (typeof origin !== 'string' || !allowed.includes(origin)) throw new ForbiddenException('MCP Origin is not allowed');
}

export function validateMcpProtocol(req: Request): void {
  const version = req.headers?.['mcp-protocol-version'];
  if (version !== undefined && (typeof version !== 'string' || !MCP_PROTOCOL_VERSIONS.includes(version as any))) throw new BadRequestException('Unsupported MCP-Protocol-Version');
}
