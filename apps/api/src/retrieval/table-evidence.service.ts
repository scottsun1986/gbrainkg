import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getPrismaClient } from '../prisma';
import { DocumentAclService } from '../permission/document-acl.service';
import { PermissionService } from '../permission/permission.service';
import { withAuthorizedRequest, assertAuthorizationSnapshot } from '../permission/authorization-revision';
import { extractRawTables, aggregateTable, cellSpans } from './table-aggregation';
import { uploadRoot } from '../storage/upload-paths';

export class TableEvidenceService {
  async readPublishedTables(userId: string, documentId: string, versionId: string) {
    return withAuthorizedRequest(userId, async snapshot => {
      if (!await new DocumentAclService(new PermissionService()).isDocumentReadable(userId, documentId)) throw new NotFoundException('Document not found');
      const version = await getPrismaClient().documentVersion.findFirst({
        where: { id: versionId, documentId, state: 'published', document: { status: 'published', activeVersionId: versionId } },
      });
      if (!version) throw new NotFoundException('Active published version not found');
      const root = uploadRoot();
      const path = resolve(root, version.mdPath);
      if (!path.startsWith(root + sep)) throw new BadRequestException('Invalid source path');
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new BadRequestException('Table source exceeds calculation budget');
      const markdown = await readFile(path, 'utf8');
      const tables = extractRawTables(markdown, version.id);
      await assertAuthorizationSnapshot(userId, snapshot);
      return { tables, sourceHash: createHash('sha256').update(markdown).digest('hex'), versionId: version.id };
    });
  }

  async execute(userId: string, request: { documentId: string; versionId: string; tableId?: string; operation?: 'count'|'sum'|'min'|'max'|'avg'; column?: number }) {
    return withAuthorizedRequest(userId, async snapshot => {
      const db = getPrismaClient();
      if (!await new DocumentAclService(new PermissionService()).isDocumentReadable(userId, request.documentId)) throw new NotFoundException('Document not found');
      const version = await db.documentVersion.findFirst({ where: { id: request.versionId, documentId: request.documentId, state: 'published', document: { status: 'published', activeVersionId: request.versionId } } });
      if (!version) throw new NotFoundException('Published version not found');
      const root = uploadRoot();
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
        // 单元格坐标通道（P1 质量-3）：聚合结果附带所操作列的逐行单元格
        // 绝对字符区间与表头，前端/审计可据此高亮到具体单元格。
        const column = typeof request.column === 'number' ? request.column : null;
        const cellRefs: Array<{ row: number; column: number; header: string | null; charStart: number; charEnd: number }> | undefined = column !== null
          ? table.rows.slice(0, 2048).map((row, index) => {
              const span = cellSpans(markdown, row).find((s) => s.column === column);
              return span
                ? { row: index + 1, column, header: table.headers[column] ?? null, charStart: span.charStart, charEnd: span.charEnd }
                : null;
            }).filter(Boolean) as Array<{ row: number; column: number; header: string | null; charStart: number; charEnd: number }>
          : undefined;
        return { ...result, documentId: request.documentId, versionId: version.id, tableId: table.id,
          rowCount: spans.length, coverage: 1, rowRange: [1, spans.length],
          column, columnHeader: column !== null ? table.headers[column] ?? null : null,
          cellRefs,
          sourceHash: createHash('sha256').update(markdown).digest('hex'),
          dependencyHash: createHash('sha256').update(JSON.stringify(spans)).digest('hex'),
          spans: spans.length <= 2048 ? spans : undefined, sourceSpan: spans.length ? { charStart: spans[0].charStart, charEnd: spans[spans.length-1].charEnd } : null };
      } catch (error) { if ((error as any)?.getStatus) throw error; throw new BadRequestException((error as Error).message); }
    });
  }
}
