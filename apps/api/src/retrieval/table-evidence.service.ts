import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { DocumentAclService } from '../permission/document-acl.service';
import { PermissionService } from '../permission/permission.service';
import { withAuthorizedRequest, assertAuthorizationSnapshot } from '../permission/authorization-revision';
import { extractRawTables, aggregateTable } from './table-aggregation';

export class TableEvidenceService {
  async execute(userId: string, request: { documentId: string; versionId: string; tableId?: string; operation?: 'count'|'sum'|'min'|'max'|'avg'; column?: number }) {
    return withAuthorizedRequest(userId, async snapshot => {
      const db = getPrismaClient();
      if (!await new DocumentAclService(new PermissionService()).isDocumentReadable(userId, request.documentId)) throw new NotFoundException('Document not found');
      const version = await db.documentVersion.findFirst({ where: { id: request.versionId, documentId: request.documentId, state: 'published', document: { status: 'published' } } });
      if (!version) throw new NotFoundException('Published version not found');
      const root = resolve(process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads');
      const path = resolve(root, version.mdPath);
      if (!path.startsWith(root + sep)) throw new BadRequestException('Invalid source path');
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new BadRequestException('Table source exceeds calculation budget');
      const markdown = await readFile(path, 'utf8');
      const tables = extractRawTables(markdown, version.id);
      if (!request.operation) { await assertAuthorizationSnapshot(userId,snapshot); return { documentId: request.documentId, versionId: version.id, tables: tables.map(table => ({ tableId: table.id, headers: table.headers, rowCount: table.rows.length })) }; }
      const table = tables.find(table => table.id === request.tableId);
      if (!table) throw new NotFoundException('Table not found');
      try {
        const result = aggregateTable(table, request.operation, request.column);
        const spans = table.rows.map((row, index) => ({ row: index + 1, charStart: row.charStart, charEnd: row.charEnd }));
        await assertAuthorizationSnapshot(userId,snapshot);
        return { ...result, documentId: request.documentId, versionId: version.id, tableId: table.id,
          rowCount: spans.length, coverage: 1, rowRange: [1, spans.length],
          sourceHash: createHash('sha256').update(markdown).digest('hex'),
          dependencyHash: createHash('sha256').update(JSON.stringify(spans)).digest('hex'),
          spans: spans.length <= 2048 ? spans : undefined, sourceSpan: spans.length ? { charStart: spans[0].charStart, charEnd: spans[spans.length-1].charEnd } : null };
      } catch (error) { if ((error as any)?.getStatus) throw error; throw new BadRequestException((error as Error).message); }
    });
  }
}
