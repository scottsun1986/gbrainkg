import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

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
 * 文档版本链：同 sourceExternalId/content 演进时创建新版本并链接，
 * 旧版标记 superseded；检索侧可沿 DocumentVersionLink 追溯。
 */
@Injectable()
export class VersionChainService {
  private readonly logger = new Logger(VersionChainService.name);

  private readonly prisma: PrismaClient;
  constructor() {
    this.prisma = getPrismaClient();
  }

  async createVersion(input: PublishNewVersionInput) {
    const relation = input.relation ?? 'supersedes';
    return this.prisma.$transaction(async (tx) => {
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

      const nextVersion = previous ? previous.version + 1 : 1;
      const doc = await tx.document.create({
        data: {
          id: randomUUID(),
          kbId: input.kbId,
          mdPath: input.mdPath,
          title: input.title,
          sourceType: input.sourceType,
          uploadedById: input.uploadedById,
          storageProvider: input.storageProvider ?? 'local',
          objectKey: input.objectKey,
          rawFileOid: input.objectKey,
          contentHash: input.contentHash,
          sourceExternalId: input.sourceExternalId,
          sensitivity: input.sensitivity ?? 'internal',
          language: input.language,
          version: nextVersion,
          status: 'parsing',
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          lifecycleStatus: 'current',
          supersedesDocumentId: previous?.id,
          parserMetadata: input.parserMetadata as never,
        },
      });

      if (previous) {
        await tx.documentVersionLink.create({
          data: {
            id: randomUUID(),
            fromDocumentId: previous.id,
            toDocumentId: doc.id,
            relation,
          },
        });
        await tx.document.update({
          where: { id: previous.id },
          data: { lifecycleStatus: 'superseded', effectiveTo: previous.effectiveTo ?? new Date() },
        });
      }
      this.logger.log(
        `document version ${doc.id} v${nextVersion} ${previous ? `supersedes ${previous.id}` : 'created'}`,
      );
      return doc;
    });
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
