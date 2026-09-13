import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { getPrismaClient } from './prisma';
import { ChunkEmbeddingService } from './embedding/chunk-embedding.service';
import { EmbeddingService } from './embedding/embedding.service';
import { GraphRagService } from './graph-rag/graph-rag.service';
import { RaptorService } from './raptor/raptor.service';
import { BrainCompilerService } from './brain-compiler/brain-compiler.service';
import { ModelConfigService } from './model-config.service';

export interface ReprocessOptions {
  embeddings?: boolean;
  forceAllEmbeddings?: boolean;
  graphRag?: boolean;
  raptor?: boolean;
  brainCompile?: boolean;
  alignReadiness?: boolean;
  clearCache?: boolean;
  kbIds?: string[];
}

export interface ReprocessLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ReprocessStats {
  scannedDocs: number;
  totalChunks: number;
  embeddedChunks: number;
  extractedEntities: number;
  extractedRelations: number;
  builtCommunities: number;
  raptorNodes: number;
  compiledScopes: number;
  clearedCacheEntries: number;
}

export interface ReprocessStatus {
  running: boolean;
  progress: number; // 0 - 100
  currentStep: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  stats: ReprocessStats;
  logs: ReprocessLogEntry[];
}

export interface CorpusStatistics {
  totalDocuments: number;
  readyDocuments: number;
  degradedDocuments: number;
  pendingDocuments: number;
  totalChunks: number;
  chunksWithEmbedding: number;
  chunksMissingEmbedding: number;
  totalGraphEntities: number;
  totalGraphRelations: number;
  totalGraphCommunities: number;
  totalRaptorNodes: number;
  semanticCacheCount: number;
}

@Injectable()
export class SystemReprocessService {
  private readonly logger = new Logger(SystemReprocessService.name);
  private readonly prisma = getPrismaClient();

  private status: ReprocessStatus = {
    running: false,
    progress: 0,
    currentStep: '空闲（等待触发）',
    startedAt: null,
    completedAt: null,
    error: null,
    stats: {
      scannedDocs: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      extractedEntities: 0,
      extractedRelations: 0,
      builtCommunities: 0,
      raptorNodes: 0,
      compiledScopes: 0,
      clearedCacheEntries: 0,
    },
    logs: [],
  };

  private cancelRequested = false;

  constructor(
    @Optional() private readonly chunkEmbeddingService?: ChunkEmbeddingService,
    @Optional() private readonly embeddingService?: EmbeddingService,
    @Optional() private readonly graphRagService?: GraphRagService,
    @Optional() private readonly raptorService?: RaptorService,
    @Optional() private readonly brainCompilerService?: BrainCompilerService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
  ) {}

  getStatus(): ReprocessStatus {
    return {
      ...this.status,
      logs: this.status.logs.slice(-100),
    };
  }

  cancelReprocess(): { success: boolean; message: string } {
    if (!this.status.running) {
      return { success: false, message: '当前没有正在运行的重处理任务。' };
    }
    this.cancelRequested = true;
    this.addLog('已收到用户取消重处理任务请求，将在当前批次结束后终止。', 'warn');
    return { success: true, message: '取消请求已发送。' };
  }

  private addLog(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const entry: ReprocessLogEntry = {
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message,
    };
    this.status.logs.push(entry);
    if (this.status.logs.length > 300) {
      this.status.logs.shift();
    }
    if (level === 'error') {
      this.logger.error(message);
    } else if (level === 'warn') {
      this.logger.warn(message);
    } else {
      this.logger.log(message);
    }
  }

  async getCorpusStatistics(): Promise<CorpusStatistics> {
    try {
      const [
        totalDocs,
        readyDocs,
        degradedDocs,
        pendingDocs,
        totalChunks,
        chunkEmbeddingStats,
        entityCount,
        relationCount,
        communityCount,
        raptorCount,
        cacheCount,
      ] = await Promise.all([
        this.prisma.document.count({ where: { status: 'published' } }),
        this.prisma.document.count({ where: { status: 'published', indexReadiness: 'ready' } }),
        this.prisma.document.count({ where: { status: 'published', indexReadiness: 'degraded' } }),
        this.prisma.document.count({ where: { status: 'published', indexReadiness: { notIn: ['ready', 'degraded'] } } }),
        this.prisma.chunk.count(),
        this.prisma.$queryRaw<Array<{ with_vector: bigint; without_vector: bigint }>>`
          SELECT 
            COUNT(*) FILTER (WHERE embedding IS NOT NULL)::bigint AS with_vector,
            COUNT(*) FILTER (WHERE embedding IS NULL)::bigint AS without_vector
          FROM "Chunk"
        `,
        (this.prisma as any).graphEntity ? (this.prisma as any).graphEntity.count() : 0,
        (this.prisma as any).graphRelation ? (this.prisma as any).graphRelation.count() : 0,
        (this.prisma as any).graphCommunity ? (this.prisma as any).graphCommunity.count() : 0,
        (this.prisma as any).raptorNode ? (this.prisma as any).raptorNode.count() : 0,
        this.prisma.semanticCache.count(),
      ]);

      const embeddingRow = chunkEmbeddingStats[0];
      return {
        totalDocuments: totalDocs,
        readyDocuments: readyDocs,
        degradedDocuments: degradedDocs,
        pendingDocuments: pendingDocs,
        totalChunks: totalChunks,
        chunksWithEmbedding: Number(embeddingRow?.with_vector || 0),
        chunksMissingEmbedding: Number(embeddingRow?.without_vector || 0),
        totalGraphEntities: Number(entityCount || 0),
        totalGraphRelations: Number(relationCount || 0),
        totalGraphCommunities: Number(communityCount || 0),
        totalRaptorNodes: Number(raptorCount || 0),
        semanticCacheCount: cacheCount,
      };
    } catch (err) {
      this.logger.warn(`Failed to gather corpus statistics: ${err instanceof Error ? err.message : String(err)}`);
      return {
        totalDocuments: 0,
        readyDocuments: 0,
        degradedDocuments: 0,
        pendingDocuments: 0,
        totalChunks: 0,
        chunksWithEmbedding: 0,
        chunksMissingEmbedding: 0,
        totalGraphEntities: 0,
        totalGraphRelations: 0,
        totalGraphCommunities: 0,
        totalRaptorNodes: 0,
        semanticCacheCount: 0,
      };
    }
  }

  async startReprocess(options: ReprocessOptions = {}): Promise<{ started: boolean; message: string }> {
    if (this.status.running) {
      throw new BadRequestException('全系统数据重处理任务正在运行中，请等待其执行完成。');
    }

    this.cancelRequested = false;
    this.status = {
      running: true,
      progress: 2,
      currentStep: '正在初始化全系统数据扫描与重处理流水线...',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      stats: {
        scannedDocs: 0,
        totalChunks: 0,
        embeddedChunks: 0,
        extractedEntities: 0,
        extractedRelations: 0,
        builtCommunities: 0,
        raptorNodes: 0,
        compiledScopes: 0,
        clearedCacheEntries: 0,
      },
      logs: [],
    };

    this.addLog('=== 开始全系统数据重新处理任务 ===');
    this.addLog(
      `配置选项: 向量嵌入=${options.embeddings !== false} (强制全部=${!!options.forceAllEmbeddings}), 图谱抽取=${options.graphRag !== false}, RAPTOR树=${options.raptor !== false}, 大脑编译=${options.brainCompile !== false}, 对齐就绪=${options.alignReadiness !== false}, 清理缓存=${options.clearCache !== false}`,
    );

    // Asynchronous background runner
    setImmediate(() => {
      this.executeReprocess(options).catch((err) => {
        this.status.running = false;
        this.status.error = err instanceof Error ? err.message : String(err);
        this.status.completedAt = new Date().toISOString();
        this.addLog(`任务异常中止: ${this.status.error}`, 'error');
      });
    });

    return { started: true, message: '全系统数据重处理任务已在后台启动。' };
  }

  private async executeReprocess(options: ReprocessOptions): Promise<void> {
    const startTime = Date.now();
    try {
      // 1. 扫描目标文档
      this.status.currentStep = '正在扫描全库已发布的文档与分块...';
      this.status.progress = 5;

      const whereClause: any = { status: 'published' };
      if (options.kbIds && options.kbIds.length > 0) {
        whereClause.kbId = { in: options.kbIds };
      }

      const docs = await this.prisma.document.findMany({
        where: whereClause,
        select: { id: true, kbId: true, title: true, version: true },
        orderBy: { createdAt: 'asc' },
      });

      this.status.stats.scannedDocs = docs.length;
      this.addLog(`已扫描到 ${docs.length} 篇已发布知识文档。`);

      if (!docs.length) {
        this.status.progress = 100;
        this.status.running = false;
        this.status.completedAt = new Date().toISOString();
        this.status.currentStep = '知识库中暂无可处理的已发布文档。';
        this.addLog('未找到已发布文档，任务结束。');
        return;
      }

      const uniqueKbIds = Array.from(new Set(docs.map((d) => d.kbId)));

      // 2. 补齐/重算向量嵌入 (Vector Embeddings)
      if (options.embeddings !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在全量补齐/重建文档分块密集向量 (BAAI/bge-m3)...';
        this.addLog('开始执行分块向量嵌入补齐与校准...');

        if (options.forceAllEmbeddings) {
          this.addLog('选项开启：强制清空历史向量并重新嵌入全部分块。', 'warn');
          await this.prisma.$executeRaw`
            UPDATE "Chunk" c
            SET embedding = NULL
            FROM "Document" d
            WHERE c."documentId" = d.id AND d.status = 'published'
          `;
        }

        let docIdx = 0;
        for (const doc of docs) {
          if (this.cancelRequested) throw new Error('用户已取消任务');
          docIdx++;
          try {
            if (this.chunkEmbeddingService) {
              const res = await this.chunkEmbeddingService.embedDocumentChunks(doc.id);
              this.status.stats.embeddedChunks += res.embedded;
              if (res.embedded > 0) {
                this.addLog(`文档 《${doc.title}》 补齐 ${res.embedded} 个分块向量。`);
              }
            }
          } catch (embedErr) {
            this.addLog(
              `文档 《${doc.title}》 向量嵌入失败: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
              'warn',
            );
          }
          this.status.progress = 5 + Math.round((docIdx / docs.length) * 30);
        }
        this.addLog(`向量嵌入阶段完成，累计更新/补齐 ${this.status.stats.embeddedChunks} 个分块向量。`);
      }

      // 3. 知识图谱深度抽取与社区发现 (GraphRAG)
      if (options.graphRag !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在全量提取知识图谱实体、关系与社区 (GraphRAG)...';
        this.status.progress = 35;
        this.addLog('开始执行知识图谱实体与关联事实抽取...');

        if (this.graphRagService) {
          let llmConfig: { baseUrl: string; apiKey: string; modelName: string } | null = null;
          if (this.modelConfigService) {
            try {
              const cfg = await this.modelConfigService.getDefault('llm');
              if (cfg) {
                llmConfig = {
                  baseUrl: (cfg.provider.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/$/, ''),
                  apiKey: cfg.provider.apiKey || process.env.DEEPSEEK_API_KEY || '',
                  modelName: cfg.modelName || process.env.LLM_MODEL || 'deepseek-chat',
                };
              }
            } catch {
              llmConfig = null;
            }
          }

          let graphDocIdx = 0;
          for (const doc of docs) {
            if (this.cancelRequested) throw new Error('用户已取消任务');
            graphDocIdx++;
            try {
              const docChunks = await this.prisma.chunk.findMany({
                where: { documentId: doc.id },
                orderBy: { ord: 'asc' },
                take: 50,
                select: { id: true, content: true, metadata: true },
              });

              if (docChunks.length > 0) {
                const elements = await this.graphRagService.extractGraphElementsHybrid(
                  doc.title,
                  doc.id,
                  docChunks,
                  doc.version,
                  llmConfig,
                );
                const saved = await this.graphRagService.persistGraphElements(doc.kbId, elements);
                this.status.stats.extractedEntities += saved.entityCount;
                this.status.stats.extractedRelations += saved.relationCount;
                if (saved.entityCount > 0 || saved.relationCount > 0) {
                  this.addLog(`《${doc.title}》抽取到 ${saved.entityCount} 个实体、${saved.relationCount} 条关系。`);
                }
              }
            } catch (graphErr) {
              this.addLog(
                `文档 《${doc.title}》 图谱抽取失败: ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`,
                'warn',
              );
            }
            this.status.progress = 35 + Math.round((graphDocIdx / docs.length) * 20);
          }

          // 重新计算并向量化知识社区
          this.status.currentStep = '正在计算全库知识社区并生成社团向量摘要...';
          for (const kbId of uniqueKbIds) {
            if (this.cancelRequested) throw new Error('用户已取消任务');
            try {
              const comms = await this.graphRagService.buildCommunitiesForKb(kbId);
              this.status.stats.builtCommunities += comms;
              if (comms > 0) {
                this.addLog(`知识库 [${kbId}] 构建并聚类了 ${comms} 个 GraphRAG 社团。`);
              }
            } catch (commErr) {
              this.addLog(
                `知识库 [${kbId}] 社团构建跳过: ${commErr instanceof Error ? commErr.message : String(commErr)}`,
                'warn',
              );
            }
          }
        } else {
          this.addLog('未检测到 GraphRagService，跳过知识图谱抽取。', 'warn');
        }
        this.addLog(
          `知识图谱阶段完成: 累计抽取实体 ${this.status.stats.extractedEntities} 个，关系 ${this.status.stats.extractedRelations} 条，知识社区 ${this.status.stats.builtCommunities} 个。`,
        );
      }

      // 4. RAPTOR 层次化摘要树构建
      if (options.raptor !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在构建 RAPTOR 层次化递归摘要树 (Level 0/1/2)...';
        this.status.progress = 65;
        this.addLog('开始执行 RAPTOR 递归分层聚类与摘要树构建...');

        if (this.raptorService && this.raptorService.isEnabled()) {
          let rapIdx = 0;
          for (const doc of docs) {
            if (this.cancelRequested) throw new Error('用户已取消任务');
            rapIdx++;
            try {
              await this.raptorService.indexDocument(doc.kbId, doc.id);
            } catch (rapErr) {
              this.addLog(
                `《${doc.title}》RAPTOR 树构建跳过: ${rapErr instanceof Error ? rapErr.message : String(rapErr)}`,
                'warn',
              );
            }
            this.status.progress = 65 + Math.round((rapIdx / docs.length) * 12);
          }

          for (const kbId of uniqueKbIds) {
            if (this.cancelRequested) throw new Error('用户已取消任务');
            try {
              this.raptorService.scheduleBuildKbGlobalTree(kbId, 0);
            } catch {}
          }

          const raptorCount = await (this.prisma as any).raptorNode.count({
            where: { kbId: { in: uniqueKbIds } },
          });
          this.status.stats.raptorNodes = Number(raptorCount || 0);
          this.addLog(`RAPTOR 树构建完成，全库共计维护 ${this.status.stats.raptorNodes} 个层次摘要节点。`);
        } else {
          this.addLog('RAPTOR 服务未启用或配置为禁用，跳过摘要树生成。', 'warn');
        }
      }

      // 5. GBrain 知识库同步与大脑编译
      if (options.brainCompile !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在同步 GBrain 底层知识源并触发大脑全员编译与访问控制对齐...';
        this.status.progress = 80;
        this.addLog('开始向 GBrain 底层同步知识源及触发全员编译...');

        if (this.brainCompilerService) {
          let syncIdx = 0;
          for (const doc of docs) {
            if (this.cancelRequested) throw new Error('用户已取消任务');
            syncIdx++;
            try {
              const topic =
                doc.title
                  .replace(/\.[^.]+$/, '')
                  .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
                  .trim() || doc.id;
              await this.brainCompilerService.onKnowledgePublished(doc.kbId, doc.id, [topic]);
            } catch (pubErr) {
              this.addLog(
                `GBrain 同步文档 《${doc.title}》 告警: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`,
                'warn',
              );
            }
            this.status.progress = 80 + Math.round((syncIdx / docs.length) * 8);
          }
          await this.brainCompilerService.queueAccessReconciliation().catch(() => undefined);
          this.status.stats.compiledScopes = uniqueKbIds.length;
          this.addLog('GBrain 知识库同步与全员访问权限对齐完成。');
        }
      }

      // 6. 文档就绪状态对齐 (Index Readiness)
      if (options.alignReadiness !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在核验文档向量覆盖率并对齐就绪状态 (indexReadiness)...';
        this.status.progress = 90;
        this.addLog('开始对齐文档 indexReadiness 状态机...');

        for (const doc of docs) {
          try {
            const missing = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
              SELECT COUNT(*)::bigint AS count FROM "Chunk" WHERE "documentId" = ${doc.id}::uuid AND embedding IS NULL
            `;
            const missingCount = Number(missing[0]?.count || 0);
            const readiness = missingCount === 0 ? 'ready' : 'degraded';
            await this.prisma.document.update({
              where: { id: doc.id },
              data: { indexReadiness: readiness },
            });
          } catch {}
        }
        this.addLog('全部文档 indexReadiness 状态已对齐完毕。');
        this.status.progress = 95;
      }

      // 7. 清理语义缓存 (Clear Semantic Cache)
      if (options.clearCache !== false) {
        if (this.cancelRequested) throw new Error('用户已取消任务');
        this.status.currentStep = '正在清空问答语义缓存，确保最新事实立即生效...';
        this.status.progress = 97;
        try {
          const res = await this.prisma.semanticCache.deleteMany({});
          this.status.stats.clearedCacheEntries = res.count;
          this.addLog(`已清除过期语义缓存 ${res.count} 条记录。`);
        } catch (cacheErr) {
          this.addLog(
            `清理语义缓存失败: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
            'warn',
          );
        }
      }

      // 完成
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      this.status.running = false;
      this.status.progress = 100;
      this.status.completedAt = new Date().toISOString();
      this.status.currentStep = `全系统数据重处理成功完成 (耗时 ${elapsedSec} 秒)。`;
      this.addLog(
        `=== 全系统数据重处理顺利完成！耗时 ${elapsedSec}s，补齐向量 ${this.status.stats.embeddedChunks} 条，提取实体 ${this.status.stats.extractedEntities} 个，关系 ${this.status.stats.extractedRelations} 条，社区 ${this.status.stats.builtCommunities} 个 ===`,
      );
    } catch (err: any) {
      this.status.running = false;
      this.status.error = err?.message || String(err);
      this.status.completedAt = new Date().toISOString();
      this.status.currentStep = `任务中止: ${this.status.error}`;
      this.addLog(`任务执行过程中止: ${this.status.error}`, 'error');
    }
  }
}
