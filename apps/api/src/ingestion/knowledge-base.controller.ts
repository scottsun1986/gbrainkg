import { Controller, Get, NotFoundException, Param, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PermissionService } from '../permission/permission.service';
import { AuthService } from '../auth/auth.service';
import { createHmac, timingSafeEqual } from 'node:crypto';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function contentTypeFor(filename: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[extname(filename).toLowerCase()] || 'application/octet-stream';
}

function previewSecret(): string {
  return process.env.PREVIEW_TOKEN_SECRET || process.env.AUTH_SECRET || 'llmwiki-local-development-secret';
}

function signPreviewPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', previewSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPreviewPayload(token: string): Record<string, any> | null {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', previewSecret()).update(body).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload?.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function onlyOfficeDocumentType(filename: string): 'word' | 'cell' | 'slide' | 'pdf' {
  const extension = extname(filename).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (['.xls', '.xlsx', '.csv'].includes(extension)) return 'cell';
  if (['.ppt', '.pptx'].includes(extension)) return 'slide';
  return 'word';
}

@Controller('api/v1/kbs')
export class KnowledgeBaseController {
  private readonly prisma = new PrismaClient();

  constructor(private readonly permissionService: PermissionService, private readonly authService: AuthService) {}

  private async currentUser(req: any): Promise<string> {
    return this.authService.userIdFromRequest(req);
  }

  @Get()
  async list(@Req() req: any, @Query('type') type?: string, @Query('page') page = '1', @Query('limit') limit = '50') {
    const userId = await this.currentUser(req);
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const where = { id: { in: visibleIds }, status: 'active', ...(type ? { type } : {}) };
    const isSystemAdmin = await this.permissionService.isSystemAdmin(userId);
    const [items, total] = await Promise.all([
      this.prisma.knowledgeBase.findMany({ where, include: { _count: { select: { documents: true } } }, skip: (pageNumber - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.knowledgeBase.count({ where }),
    ]);
    const writePermissions = await Promise.all(items.map((item) => this.permissionService.canManageKnowledgeBase(userId, item.id)));
    return { items: items.map(({ _count, ...item }, index) => ({ ...item, documentCount: _count.documents, canWrite: writePermissions[index], canDelete: isSystemAdmin || item.ownerUserId === userId })), total, page: pageNumber, limit: pageSize };
  }

  @Get(':kbId/documents')
  async listDocuments(@Param('kbId') kbId: string, @Req() req: any, @Query('status') status?: string, @Query('page') page = '1', @Query('limit') limit = '50') {
    const userId = await this.currentUser(req);
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId)) throw new NotFoundException('Knowledge base not found.');
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const where = { kbId, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({ where, skip: (pageNumber - 1) * pageSize, take: pageSize, orderBy: { updatedAt: 'desc' } }),
      this.prisma.document.count({ where }),
    ]);
    const uploaderIds = [...new Set(items.map((item) => item.uploadedById).filter((id): id is string => Boolean(id)))];
    const uploaders = await this.prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, displayName: true, username: true } });
    const uploaderById = new Map(uploaders.map((user) => [user.id, user]));
    return {
      items: items.map((item) => ({
        ...item,
        uploadedBy: item.uploadedById ? uploaderById.get(item.uploadedById) || null : null,
      })),
      total, page: pageNumber, limit: pageSize,
    };
  }

  @Get(':kbId/documents/:docId')
  async getDocument(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId)) throw new NotFoundException('Document not found.');
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId)) throw new NotFoundException('Document not found.');
    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId }, include: { chunks: { orderBy: { ord: 'asc' }, select: { content: true } } } });
    if (!document) throw new NotFoundException('Document not found.');
    return { document, markdown_content: document.chunks.map((chunk) => chunk.content).join('\n\n') };
  }

  @Get(':kbId/documents/:docId/preview-config')
  async getPreviewConfig(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId)) throw new NotFoundException('Document not found.');
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId)) throw new NotFoundException('Document not found.');
    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId }, select: { id: true, kbId: true, title: true, version: true, updatedAt: true, rawFileOid: true } });
    if (!document?.rawFileOid) throw new NotFoundException('Original file not found.');
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const fileToken = signPreviewPayload({ userId, kbId, docId, exp });
    const storageBase = process.env.PREVIEW_STORAGE_BASE_URL || `${req.protocol || 'http'}://${req.get?.('host') || req.headers.host}`;
    const documentServerUrl = process.env.ONLYOFFICE_URL || `${req.protocol || 'http'}://${String(req.headers.host || 'localhost').split(':')[0]}:8090`;
    const fileUrl = `${storageBase.replace(/\/$/, '')}/api/v1/kbs/${kbId}/documents/${docId}/preview-file?token=${encodeURIComponent(fileToken)}`;
    return {
      documentServerUrl,
      config: {
        document: {
          fileType: extname(document.title).replace('.', '').toLowerCase() || 'docx',
          key: `${document.id}-${document.version}-${document.updatedAt.getTime()}`.slice(0, 120),
          title: document.title,
          url: fileUrl,
          permissions: { edit: false, download: false, print: false, comment: false, fillForms: false, copy: false },
        },
        documentType: onlyOfficeDocumentType(document.title),
        editorConfig: { mode: 'view', lang: 'zh-CN', customization: { autosave: false, forcesave: false, compactHeader: true } },
        height: '100%',
        type: 'desktop',
      },
    };
  }

  @Get(':kbId/documents/:docId/file')
  async getOriginalFile(@Param('kbId') kbId: string, @Param('docId') docId: string, @Req() req: any, @Res() response: Response) {
    const userId = await this.currentUser(req);
    if (!isUuid(kbId) || !isUuid(docId)) throw new NotFoundException('Document not found.');
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(userId);
    if (!visibleIds.includes(kbId)) throw new NotFoundException('Document not found.');
    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId }, select: { title: true, rawFileOid: true } });
    if (!document?.rawFileOid) throw new NotFoundException('Original file not found.');
    const bytes = await readFile(document.rawFileOid).catch(() => null);
    if (!bytes) throw new NotFoundException('Original file not found.');
    const filename = encodeURIComponent(document.title).replace(/'/g, '%27');
    response.setHeader('Content-Type', contentTypeFor(document.title));
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filename}`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }

  @Get(':kbId/documents/:docId/preview-file')
  async getPreviewFile(@Param('kbId') kbId: string, @Param('docId') docId: string, @Query('token') token: string, @Res() response: Response) {
    if (!isUuid(kbId) || !isUuid(docId)) throw new NotFoundException('Document not found.');
    const payload = verifyPreviewPayload(token);
    if (!payload || payload.kbId !== kbId || payload.docId !== docId || !payload.userId) throw new UnauthorizedException('Preview token is invalid or expired.');
    // Re-check current authorization at the storage endpoint as well. The
    // short-lived token is only a transport credential for OnlyOffice.
    const visibleIds = await this.permissionService.getVisibleKnowledgeBases(payload.userId);
    if (!visibleIds.includes(kbId)) throw new UnauthorizedException('Preview access is no longer authorized.');
    const document = await this.prisma.document.findFirst({ where: { id: docId, kbId }, select: { title: true, rawFileOid: true } });
    if (!document?.rawFileOid) throw new NotFoundException('Original file not found.');
    const bytes = await readFile(document.rawFileOid).catch(() => null);
    if (!bytes) throw new NotFoundException('Original file not found.');
    response.setHeader('Content-Type', contentTypeFor(document.title));
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.title).replace(/'/g, '%27')}`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }
}
