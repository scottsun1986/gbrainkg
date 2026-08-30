import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Optional } from '@nestjs/common';
import { BrainRepoAdapter } from '@llmwiki/gbrain-adapter';
import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../permission/permission.service';
import { ModelConfigService } from '../model-config.service';
import { BrainCompilerService } from './brain-compiler.service';
import { readCanonicalDocument } from './canonical-document';

@Processor('dirty-compiler-queue')
export class BrainCompilerProcessor extends WorkerHost {
  private readonly logger = new Logger(BrainCompilerProcessor.name);
  private prisma = new PrismaClient();
  private gbrain = new BrainRepoAdapter(process.env.BRAIN_REPO_BASE_PATH || '/tmp/llmwiki/brain_repos');
  private readonly uploadRoot = process.env.UPLOAD_ROOT || '/tmp/llmwiki/uploads';

  constructor(@Optional() private readonly permissionService?: PermissionService, @Optional() private readonly modelConfigService?: ModelConfigService, @Optional() private readonly compilerService?: BrainCompilerService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { userId, topicSlug, source, docIds = [], sourceKey } = job.data;
    this.logger.debug(`Starting compile job for User: ${userId}, Topic: ${topicSlug}`);

    try {
      await this.modelConfigService?.applyRuntimeConfig();
      const brainRepo = await this.prisma.brainRepo.findUnique({ where: { userId } });
      if (!brainRepo) throw new Error(`BrainRepo not found for user ${userId}`);

      const visibleKbIds = this.permissionService
        ? await this.permissionService.getVisibleKnowledgeBases(userId)
        : [];
      const documents = this.prisma.document?.findMany && visibleKbIds.length > 0
        ? await this.prisma.document.findMany({
            where: {
              kbId: { in: visibleKbIds },
              status: 'published',
              ...(docIds.length > 0
                ? { id: { in: docIds } }
                : { OR: [{ title: { contains: topicSlug, mode: 'insensitive' } }, { chunks: { some: { content: { contains: topicSlug, mode: 'insensitive' } } } }] }),
            },
            include: {
              kb: { select: { name: true, type: true } },
              chunks: { orderBy: { ord: 'asc' }, select: { content: true, charStart: true, charEnd: true, metadata: true } },
            },
            take: 20,
          })
        : [];
      const evidences = await Promise.all(documents.map(async (document) => ({
        text: await readCanonicalDocument(this.uploadRoot, document.id, document.chunks),
        sourceFile: document.title,
        kbId: document.kbId,
        kbName: document.kb.name,
        kbType: document.kb.type,
        topic: document.title.replace(/\.[^.]+$/, ''),
        slug: `docs/${document.id}`,
      })));

      // Published knowledge is written incrementally to its shared source or
      // private permission-group source. No per-user full rebuild is performed.
      if (sourceKey && this.compilerService) {
        await this.compilerService.syncSourceIncremental(sourceKey, userId, docIds);
      } else {
        await this.gbrain.ingest(sourceKey ? `gbrain://source/${sourceKey}` : brainRepo.gitRepoUrl, evidences);
      }

      if (docIds.length && this.prisma.document?.updateMany) {
        await this.prisma.document.updateMany({
          where: { id: { in: docIds }, status: 'indexing' },
          data: { status: 'published' },
        });
      }

      if (this.prisma.brainTopic.upsert) {
        await this.prisma.brainTopic.upsert({
          where: { brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug } },
          create: { brainRepoId: brainRepo.id, topicSlug, mdPath: `${topicSlug}.md`, lastCompiledAt: new Date() },
          update: { compileStatus: 'clean', lastCompiledAt: new Date(), dirtySource: source },
        });
      } else {
        await this.prisma.brainTopic.update({
          where: { brainRepoId_topicSlug: { brainRepoId: brainRepo.id, topicSlug } },
          data: { compileStatus: 'clean', lastCompiledAt: new Date() },
        });
      }
      await this.prisma.brainRepo.update?.({ where: { id: brainRepo.id }, data: { lastCompileAt: new Date() } });

      return { status: 'success', topicSlug };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      if (docIds.length && this.prisma.document?.updateMany) {
        await this.prisma.document.updateMany({
          where: { id: { in: docIds }, status: 'indexing' },
          data: { status: 'failed' },
        }).catch(() => undefined);
      }
      this.logger.error(`Compile job failed: ${message}`, stack);
      throw error;
    }
  }
}
