import { mkdir, copyFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { uploadRoot, resolveUploadPath } from '../storage/upload-paths';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { enqueueDocumentParse } from './ingestion-queue';
import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { withSystemWrite } from '../db/tenant-context.service';

export type VersionRelation = 'supersedes' | 'revision' | 'translation';

export interface PublishNewVersionInput {
  kbId: string;
  documentId?: string; // 既有文档 = 升版；不传 = 新建
  title: string;
  mdPath: string;
  sourceType: string;
  uploadedById?: string;
  objectKey?: string;
  storageProvider?: string;
  contentHash?: string;
  sourceExternalId?: string;
  sensitivity?: string;
  language?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date;
  relation?: VersionRelation;
  parserMetadata?: unknown;
}

/**
 * 文档版本链：同 sourceExternalId/content 演进时创建新版本并链接。
 * 旧版在新版成功发布前保持 current（B02）：退役动作移入发布事务
 * （见 version-chain-retirement.ts），创建阶段只记录待发布意图。
 */
@Injectable()
export class VersionChainService {
  private readonly logger = new Logger(VersionChainService.name);

  private readonly prisma: PrismaClient;
  constructor(@InjectQueue("ingestion-queue") private readonly ingestionQueue: Queue) {
    this.prisma = getPrismaClient();
  }

  async createVersion(input: PublishNewVersionInput) {
    const relation = input.relation ?? 'supersedes';
    const documentId = randomUUID();
    let directory: string | undefined;
    let doc;
    try {
      // Version publication writes system-owned artifacts (DocumentVersion,
      // DocumentVersionLink, chunk projections, enrichment stages) whose policies
      // are service-only. The endpoint has already authorised the caller against
      // this document, so the write runs with the service identity.
      doc = await withSystemWrite(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT id FROM "KnowledgeBase" WHERE id = ${input.kbId}::uuid FOR UPDATE`;
      const previous = input.documentId
        ? await tx.document.findUnique({ where: { id: input.documentId } })
        : input.sourceExternalId
          ? await tx.document.findFirst({
              where: {
                kbId: input.kbId,
                sourceExternalId: input.sourceExternalId,
                lifecycleStatus: 'current',
              },
              orderBy: { version: 'desc' },
            })
          : null;

      if (previous && previous.lifecycleStatus !== "current") throw new ConflictException("Document version has already been superseded");
      if (previous && !['published', 'failed'].includes(previous.status)) {
        // A version replacement targets live knowledge: superseding a document
        // that is itself still building would let the two publications land out
        // of order. Retry or fix the predecessor first (retryDocument covers
        // failed/needs_review/stale-parsing documents).
        throw new ConflictException(`Document version cannot be superseded while its status is ${previous.status}`);
      }
      if (previous) {
        // At most one non-failed successor may be in flight (B02): otherwise a
        // repeated request would build two replacements and publish two current
        // versions. Failed successors do not block — that is the retry path.
        const building = (await tx.documentVersionLink.findMany({
          where: { fromDocumentId: previous.id, relation: { not: 'translation' } },
          select: { toDocumentId: true, toDocument: { select: { status: true } } },
        })) as Array<{ toDocumentId: string; toDocument?: { status?: string } }>;
        if (building.some(link => link.toDocument?.status !== undefined && !['published', 'failed'].includes(link.toDocument.status))) {
          throw new ConflictException("A newer version of this document is already being built");
        }
      }
      directory = join(uploadRoot(), documentId);
      await mkdir(directory, { recursive: true });
      const sourceRaw = input.objectKey || previous?.rawFileOid;
      if (!sourceRaw) throw new ConflictException("Original source file required for version creation");
      const rawFileOid = join(directory, `raw${basename(sourceRaw).includes(".") ? basename(sourceRaw).slice(basename(sourceRaw).lastIndexOf(".")) : ".txt"}`);
      await copyFile(resolveUploadPath(sourceRaw), rawFileOid);
      const mdPath = `${documentId}/content.md`;
      await copyFile(resolveUploadPath(input.mdPath), join(uploadRoot(), mdPath)).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
      const nextVersion = previous ? previous.version + 1 : 1;
      const doc = await tx.document.create({
        data: {
          id: documentId,
          kbId: input.kbId,
          mdPath,
          title: input.title,
          sourceType: input.sourceType,
          uploadedById: input.uploadedById,
          storageProvider: input.storageProvider ?? 'local',
          objectKey: undefined,
          rawFileOid,
          contentHash: input.contentHash,
          sourceExternalId: input.sourceExternalId,
          sensitivity: input.sensitivity ?? 'internal',
          language: input.language,
          version: nextVersion,
          ingestVersion: nextVersion,
          aclMode: previous?.aclMode || 'inherit',
          status: 'parsing',
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          lifecycleStatus: 'current',
          supersedesDocumentId: previous?.id,
          parserMetadata: input.parserMetadata as never,
        },
      });

      if (previous) {
        const grants = await tx.documentAcl.findMany({ where: { documentId: previous.id } });
        if (grants.length) await tx.documentAcl.createMany({ data: grants.map((grant: any) => ({
          id: randomUUID(), documentId: doc.id, subjectType: grant.subjectType, subjectId: grant.subjectId, permission: grant.permission,
        })) });
        // Pending-intent link only: the predecessor is retired inside the
        // successor's successful publish transaction (B02), not here.
        await tx.documentVersionLink.create({
          data: {
            id: randomUUID(),
            fromDocumentId: previous.id,
            toDocumentId: doc.id,
            relation,
          },
        });
      }
      this.logger.log(
        `document version ${doc.id} v${nextVersion} ${previous ? `supersedes ${previous.id} on publish` : 'created'}`,
      );
      return doc;
      });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await enqueueDocumentParse(this.ingestionQueue, doc.id, doc.version, "upload");
    } catch (error) {
      // The successor row committed but the queue never accepted the job. The
      // predecessor keeps serving (B02); mark this candidate failed so the
      // in-flight guard above allows a retry instead of leaving an eternal
      // "building" successor. The copied files stay for the retry.
      await this.prisma.document.updateMany({
        where: { id: doc.id, status: 'parsing' },
        data: { status: 'failed' },
      }).catch(() => undefined);
      throw error;
    }
    return doc;
  }

  async listChain(documentId: string) {
    const links = await this.prisma.documentVersionLink.findMany({
      where: { OR: [{ fromDocumentId: documentId }, { toDocumentId: documentId }] },
      include: {
        fromDocument: { select: { id: true, title: true, version: true, lifecycleStatus: true, createdAt: true } },
        toDocument: { select: { id: true, title: true, version: true, lifecycleStatus: true, createdAt: true } },
      },
    });
    return links;
  }
}
