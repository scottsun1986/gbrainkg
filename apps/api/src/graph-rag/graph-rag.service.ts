import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { detectCommunitiesLouvain } from './louvain';
import { getPrismaClient } from '../prisma';
import { EmbeddingService } from '../embedding/embedding.service';
import { ModelConfigService } from '../model-config.service';
import { withServiceContext } from '../db/tenant-context.service';
import { recordFailopen } from '../observability/failopen';

export type EntityType = 'concept' | 'organization' | 'system' | 'policy' | 'person' | 'document';
export type RelationType = 'contains' | 'references' | 'regulates' | 'depends_on' | 'relates_to' | 'mentions' | 'supersedes' | 'amends';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description?: string;
  sourceDocId?: string;
}

export interface ExtractedRelation {
  sourceName: string;
  targetName: string;
  relationType: RelationType;
  description?: string;
  snippet?: string;
  provenanceDocId?: string;
  chunkId?: string;
  weight?: number;
  documentVersion?: number;
}

export interface LocalGraphSearchResult {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    description?: string | null;
  }>;
  relations: Array<{
    source: string;
    target: string;
    relationType: string;
    weight: number;
    snippet?: string;
    provenance: Array<{
      documentId?: string;
      documentVersion?: number;
      chunkId?: string;
      snippet?: string;
    }>;
  }>;
  formattedContext: string;
}

export interface GlobalCommunitySearchResult {
  communities: Array<{
    id: string;
    title: string;
    summary: string;
    findings: any[];
  }>;
  formattedContext: string;
}

export interface DriftSearchPlan {
  probes: string[];
  communityIds: string[];
  seedEntities: string[];
}

function cleanLabel(value: string): string {
  return value.replace(/^#+\s*/, '').replace(/\.(pdf|docx?|pptx?|xlsx?|md|txt|csv)$/i, '').trim();
}

@Injectable()
export class GraphRagService {
  private readonly logger = new Logger(GraphRagService.name);
  private prisma = getPrismaClient();

  constructor(
    @Optional() private readonly embeddingService?: EmbeddingService,
    @Optional() private readonly modelConfigService?: ModelConfigService,
    @Optional() @InjectQueue('graph-community-queue') private readonly communityQueue?: Queue,
  ) {}

  /**
   * Coalesced, durable community rebuild for one knowledge base.
   *
   * Community detection reads *every* entity and relation of a KB
   * (`buildCommunitiesForKb`), so invoking it once per ingested document is an
   * O(documents × graph)² cost. During a bulk import that is the dominant
   * enrichment cost and a memory spike. Instead, every document marks the KB
   * dirty by enqueuing a single delayed job keyed by `graph-community-<kbId>`;
   * BullMQ deduplicates the jobId (Redis-backed, so across every instance), so
   * a burst of N documents collapses to one rebuild after the debounce window.
   *
   * Falls back to a direct synchronous rebuild when no queue is assembled
   * (unit tests, or a deployment without Redis) so behaviour is unchanged there.
   */
  async scheduleCommunityRebuild(kbId: string): Promise<void> {
    const debounceMs = Math.max(
      0,
      Number(process.env.GRAPHRAG_COMMUNITY_DEBOUNCE_MS || 15_000),
    );
    if (!this.communityQueue || typeof this.communityQueue.add !== 'function') {
      await this.buildCommunitiesForKb(kbId, { incremental: true }).catch(() => undefined);
      return;
    }
    try {
      await this.communityQueue.add(
        'rebuild',
        { kbId },
        {
          jobId: `graph-community-${kbId}`,
          delay: debounceMs,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: Number(process.env.GRAPHRAG_COMMUNITY_ATTEMPTS || 2),
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );
    } catch (err) {
      // A queue outage must not fail document enrichment: fall back to the
      // (more expensive but correct) synchronous rebuild.
      this.logger.warn(
        `Community rebuild enqueue failed for KB ${kbId}, rebuilding inline: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.buildCommunitiesForKb(kbId, { incremental: true }).catch(() => undefined);
    }
  }

  /**
   * The configured chat route, used for community summaries. Returns null when
   * no route is configured, in which case community summaries fall back to the
   * deterministic template instead of failing.
   */
  private async getLlmConfig(): Promise<{ baseUrl: string; apiKey: string; modelName: string } | null> {
    if (!this.modelConfigService) return null;
    try {
      const config = (await this.modelConfigService.getLlmChatConfig('llmwiki-graph-summary')) ??
        (await this.modelConfigService.getDefault('fast_llm')) ??
        (await this.modelConfigService.getDefault('llm'));
      if (!config) return null;
      const baseUrl = String((config as any).baseUrl || (config as any).provider?.baseUrl || '').replace(/\/$/, '');
      const apiKey = String((config as any).apiKey || (config as any).provider?.apiKey || '');
      const modelName = String((config as any).modelName || '');
      if (!baseUrl || !modelName) return null;
      return { baseUrl, apiKey, modelName };
    } catch {
      return null;
    }
  }

  /**
   * Naming-affix lexicons used by the regex fallback extraction.
   *
   * These are generic language affixes (Chinese organisation / system / policy
   * nouns), not deployment-specific facts, but the exact set is corpus-shaped:
   * an English corpus or a non-organisational corpus wants a different list.
   * They are therefore environment-overridable instead of compiled in, so a
   * deployment can tune extraction without a code change (AGENTS.md §2).
   */
  private entitySuffixes(): { organization: string[]; system: string[]; policy: string[] } {
    const parse = (value: string | undefined, fallback: string): string[] =>
      String(value ?? fallback)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      organization: parse(
        process.env.GRAPHRAG_ORG_SUFFIXES,
        '公司,集团,部门,中心,小组,委员会,团队,部,处,室',
      ),
      system: parse(
        process.env.GRAPHRAG_SYSTEM_SUFFIXES,
        '系统,平台,服务,引擎,数据库,架构,网关,模块,中间件',
      ),
      policy: parse(
        process.env.GRAPHRAG_POLICY_SUFFIXES,
        '规范,制度,标准,规程,办法,指南,方案,条例,守则,准则',
      ),
    };
  }

  private readonly suffixRegexCache = new Map<string, RegExp>();

  private suffixRegex(kind: string, suffixes: string[]): RegExp {
    const key = `${kind}:${suffixes.join('|')}`;
    const cached = this.suffixRegexCache.get(key);
    if (cached) return cached;
    const escaped = suffixes
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    const re = escaped.length ? new RegExp(`(?:${escaped.join('|')})$`, 'u') : /$^/;
    this.suffixRegexCache.set(key, re);
    if (this.suffixRegexCache.size > 32) {
      const oldest = this.suffixRegexCache.keys().next().value;
      if (oldest) this.suffixRegexCache.delete(oldest);
    }
    return re;
  }

  /**
   * Determine entity semantic category by naming heuristics and patterns.
   * The affix lists are corpus-configurable (see `entitySuffixes`).
   */
  classifyEntityType(name: string): EntityType {
    const trimmed = name.trim();
    const suffixes = this.entitySuffixes();
    if (this.suffixRegex('org', suffixes.organization).test(trimmed)) {
      return 'organization';
    }
    if (this.suffixRegex('system', suffixes.system).test(trimmed)) {
      return 'system';
    }
    if (
      /^[《「].+[》」]$/u.test(trimmed) ||
      this.suffixRegex('policy', suffixes.policy).test(trimmed)
    ) {
      return 'policy';
    }
    return 'concept';
  }

  /**
   * Extracts entities and relations from document text & chunks,
   * aligning with Tencent WeKnora / GraphRAG principles.
   */
  extractGraphElements(
    title: string,
    docId: string,
    chunks: Array<{ id?: string; content: string; metadata?: any }>,
    documentVersion?: number,
  ): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } {
    const docCleanTitle = cleanLabel(title);
    const entityMap = new Map<string, ExtractedEntity>();
    const relations: ExtractedRelation[] = [];
    const version = documentVersion ?? 1;

    const registerEntity = (name: string, explicitType?: EntityType, desc?: string) => {
      let cleaned = cleanLabel(name).replace(/[「」《》“”"']/g, '').trim();
      cleaned = cleaned.replace(/^(由|关于|基于)/u, '').trim();
      if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return null;
      if (/^(文档正文|目录|正文|内容|附件|第一条|第二条|第三条)$/u.test(cleaned)) return null;

      if (!entityMap.has(cleaned)) {
        entityMap.set(cleaned, {
          name: cleaned,
          type: explicitType || this.classifyEntityType(cleaned),
          description: desc,
          sourceDocId: docId,
        });
      }
      return cleaned;
    };

    // Document root entity
    registerEntity(docCleanTitle, 'document', `原始知识文档: ${docCleanTitle}`);

    for (const chunk of chunks) {
      const content = chunk.content || '';
      const chunkId = chunk.id;

      // 1. Heading extraction
      for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
        const headingName = registerEntity(match[1], 'concept');
        if (headingName) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: headingName,
            relationType: 'contains',
            snippet: match[0],
            provenanceDocId: docId,
            chunkId,
            weight: 1.5,
            documentVersion: version,
          });
        }
      }

      // 2. Policy and cited entity extraction (《...》)
      for (const match of content.matchAll(/[《「“]([^》」”]{2,60})[》」”]/gu)) {
        const policyName = registerEntity(match[1], 'policy');
        if (policyName && policyName !== docCleanTitle) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: policyName,
            relationType: 'references',
            snippet: `文件引用：《${match[1]}》`,
            provenanceDocId: docId,
            chunkId,
            weight: 2.0,
            documentVersion: version,
          });
        }
      }

      // 3. Organization and system entities. The affix list is corpus-tunable
      //    (GRAPHRAG_ORG_SUFFIXES / GRAPHRAG_SYSTEM_SUFFIXES); the regex is
      //    compiled from the same lexicons used by classifyEntityType.
      const suffixes = this.entitySuffixes();
      const orgSystemAffixes = [...suffixes.organization, ...suffixes.system]
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length)
        .join('|');
      const orgSystemRegex = orgSystemAffixes
        ? new RegExp(`([\\p{L}\\p{N}]{2,32}(?:${orgSystemAffixes}))`, 'gu')
        : null;
      for (const match of orgSystemRegex ? content.matchAll(orgSystemRegex) : []) {
        const termName = registerEntity(match[1]);
        if (termName && termName !== docCleanTitle) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: termName,
            relationType: 'mentions',
            snippet: match[1],
            provenanceDocId: docId,
            chunkId,
            weight: 1.0,
            documentVersion: version,
          });
        }
      }

      // 4. WikiLinks [[...]]
      for (const match of content.matchAll(/\[\[([^\]]+)\]\]/gu)) {
        const linkName = registerEntity(match[1], 'concept');
        if (linkName && linkName !== docCleanTitle) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: linkName,
            relationType: 'relates_to',
            snippet: `WikiLink: [[${match[1]}]]`,
            provenanceDocId: docId,
            chunkId,
            weight: 1.8,
            documentVersion: version,
          });
        }
      }

      // 5. Temporal precedence & amendment extraction (supersedes / amends)
      for (const match of content.matchAll(/(?:废止|替代|取代|废除|修订单号|替代原|原规程|原标准)[：:\s]*[《「“]([^》」”]{2,60})[》」”]/gu)) {
        const supersededName = registerEntity(match[1], 'policy');
        if (supersededName && supersededName !== docCleanTitle) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: supersededName,
            relationType: 'supersedes',
            snippet: match[0],
            provenanceDocId: docId,
            chunkId,
            weight: 3.0,
            documentVersion: version,
          });
        }
      }

      for (const match of content.matchAll(/(?:修订|修正|补充)[：:\s]*[《「“]([^》」”]{2,60})[》」”]/gu)) {
        const amendedName = registerEntity(match[1], 'policy');
        if (amendedName && amendedName !== docCleanTitle) {
          relations.push({
            sourceName: docCleanTitle,
            targetName: amendedName,
            relationType: 'amends',
            snippet: match[0],
            provenanceDocId: docId,
            chunkId,
            weight: 2.5,
            documentVersion: version,
          });
        }
      }
    }

    return {
      entities: Array.from(entityMap.values()),
      relations,
    };
  }

  /**
   * Uses LLM to extract entities and relations from a chunk with higher accuracy
   * than regex-based extraction. Falls back to regex on LLM failure.
   */
  async extractEntitiesWithLLM(
    chunkContent: string,
    docTitle: string,
    docId: string,
    chunkId: string | undefined,
    documentVersion: number,
    llmConfig: { baseUrl: string; apiKey: string; modelName: string } | null,
  ): Promise<{ entities: ExtractedEntity[]; relations: ExtractedRelation[] }> {
    if (!llmConfig || !chunkContent.trim() || chunkContent.length < 50) {
      return { entities: [], relations: [] };
    }

    const prompt = `请从以下文本中提取知识图谱的实体和关系。

文本:
${chunkContent.slice(0, 4000)}

请以 JSON 格式输出，格式如下：
{
  "entities": [
    {"name": "实体名", "type": "concept|organization|system|policy|person|document", "description": "简短描述"}
  ],
  "relations": [
    {"source": "源实体名", "target": "目标实体名", "type": "contains|references|regulates|depends_on|relates_to|mentions|supersedes|amends", "evidence": "原文证据"}
  ]
}

要求：
1. 实体名必须是文本中明确出现的名词或专有名词
2. 每条关系必须附带 evidence（原文中的依据）
3. type 必须是指定的枚举值之一（包含 supersedes 替代废止、amends 修订补充）
4. 过滤掉过于泛化的词（如"内容"、"文档"、"目录"等）
5. 只输出 JSON，不要其他内容`;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      };
      // OpenCode Zen Go requires a routing session header.
      if (llmConfig.baseUrl.includes('opencode.ai')) headers['x-opencode-session'] = 'llmwiki-graph';
      const response = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: llmConfig.modelName,
          messages: [
            { role: 'system', content: '你是一个专业的知识图谱构建助手。只输出合法的 JSON。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        this.logger.warn(`LLM entity extraction failed: HTTP ${response.status}`);
        return { entities: [], relations: [] };
      }

      const payload: any = await response.json();
      let content = String(payload?.choices?.[0]?.message?.content || '').trim();
      
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) content = jsonMatch[1].trim();
      
      const parsed = JSON.parse(content);
      
      const entities: ExtractedEntity[] = [];
      const relations: ExtractedRelation[] = [];
      // 'person' is offered by the extraction prompt; it used to be missing from
      // this whitelist, so every person entity was silently re-classified by the
      // naming heuristic (which can only return concept/organization/system/
      // policy) and a person's type never survived extraction.
      const validTypes: EntityType[] = ['concept', 'organization', 'system', 'policy', 'person', 'document'];
      const validRelTypes: RelationType[] = ['contains', 'references', 'regulates', 'depends_on', 'relates_to', 'mentions', 'supersedes', 'amends'];

      if (Array.isArray(parsed.entities)) {
        for (const e of parsed.entities) {
          if (!e.name || typeof e.name !== 'string' || e.name.length < 2 || e.name.length > 80) continue;
          const type = validTypes.includes(e.type) ? e.type : this.classifyEntityType(e.name);
          entities.push({
            name: cleanLabel(e.name),
            type,
            description: e.description || undefined,
            sourceDocId: docId,
          });
        }
      }

      if (Array.isArray(parsed.relations)) {
        for (const r of parsed.relations) {
          if (!r.source || !r.target || r.source === r.target) continue;
          const relType = validRelTypes.includes(r.type) ? r.type : 'relates_to';
          relations.push({
            sourceName: cleanLabel(r.source),
            targetName: cleanLabel(r.target),
            relationType: relType,
            description: r.evidence || undefined,
            snippet: r.evidence || undefined,
            provenanceDocId: docId,
            chunkId,
            weight: 2.0, // Higher weight for LLM-extracted relations
            documentVersion,
          });
        }
      }

      this.logger.log(`LLM extracted ${entities.length} entities, ${relations.length} relations from chunk`);
      return { entities, relations };
    } catch (err) {
      this.logger.warn(`LLM entity extraction error: ${err instanceof Error ? err.message : String(err)}`);
      return { entities: [], relations: [] };
    }
  }

  /**
   * Hybrid extraction: combines fast regex extraction with LLM deep extraction.
   * LLM is used selectively for chunks with high entity density or complex content.
   */
  async extractGraphElementsHybrid(
    title: string,
    docId: string,
    chunks: Array<{ id?: string; content: string; metadata?: any }>,
    documentVersion: number | undefined,
    llmConfig: { baseUrl: string; apiKey: string; modelName: string } | null,
    options: { llmSampleRate?: number; maxLlmChunks?: number } = {},
  ): Promise<{ entities: ExtractedEntity[]; relations: ExtractedRelation[] }> {
    // Step 1: Always run fast regex extraction
    const regexResult = this.extractGraphElements(title, docId, chunks, documentVersion);
    
    if (!llmConfig) {
      return regexResult;
    }

    // Step 2: Select chunks for LLM deep extraction
    const sampleRate = options.llmSampleRate ?? 0.3; // Process 30% of chunks with LLM
    const maxLlmChunks = options.maxLlmChunks ?? 20;
    
    // Prioritize chunks with high entity density (more regex matches) or tables
    const scoredChunks = chunks.map((chunk, idx) => {
      let score = 0;
      if (chunk.content.includes('|') && chunk.content.includes('---')) score += 2; // tables
      if (/[《「"]/.test(chunk.content)) score += 1; // policy references
      if (/第[\d一二三四五六七八九十]+[章节条]/.test(chunk.content)) score += 1; // clause structure
      if (chunk.content.length > 500) score += 1; // substantial content
      return { chunk, idx, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.ceil(chunks.length * sampleRate), maxLlmChunks));

    // Step 3: Run LLM extraction on selected chunks (with concurrency limit)
    const allLlmEntities: ExtractedEntity[] = [];
    const allLlmRelations: ExtractedRelation[] = [];
    const concurrency = 3;
    const version = documentVersion ?? 1;

    for (let i = 0; i < scoredChunks.length; i += concurrency) {
      const batch = scoredChunks.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(({ chunk }) =>
          this.extractEntitiesWithLLM(
            chunk.content,
            title,
            docId,
            chunk.id,
            version,
            llmConfig,
          ),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allLlmEntities.push(...result.value.entities);
          allLlmRelations.push(...result.value.relations);
        }
      }
    }

    // Step 4: Merge regex + LLM results (deduplicate entities by name)
    const entityMap = new Map<string, ExtractedEntity>();
    for (const e of regexResult.entities) {
      entityMap.set(e.name, e);
    }
    for (const e of allLlmEntities) {
      const existing = entityMap.get(e.name);
      if (!existing) {
        entityMap.set(e.name, e);
      } else if (e.description) {
        // Merge descriptions rather than dropping one side: regex and LLM
        // often capture different facets of the same entity, and discarding
        // the LLM detail is exactly how bridge-entity evidence was lost.
        const merged = existing.description
          ? existing.description.includes(e.description)
            ? existing.description
            : `${existing.description}；${e.description}`
          : e.description;
        entityMap.set(e.name, { ...existing, description: merged.slice(0, 600) });
      }
    }

    // Deduplicate relations while preserving the richest description/snippet
    // and the union of provenance instead of silently discarding duplicates.
    const relKey = (r: ExtractedRelation) => `${r.sourceName}|${r.targetName}|${r.relationType}`;
    const mergeRelation = (prev: ExtractedRelation, next: ExtractedRelation): ExtractedRelation => ({
      ...prev,
      description:
        next.description && next.description.length > (prev.description?.length ?? 0)
          ? next.description
          : prev.description,
      snippet:
        next.snippet && next.snippet.length > (prev.snippet?.length ?? 0)
          ? next.snippet
          : prev.snippet,
      weight: Math.max(Number(prev.weight ?? 0), Number(next.weight ?? 0)) || prev.weight,
    });
    const relMap = new Map<string, ExtractedRelation>();
    for (const r of regexResult.relations) {
      const key = relKey(r);
      const existing = relMap.get(key);
      relMap.set(key, existing ? mergeRelation(existing, r) : r);
    }
    for (const r of allLlmRelations) {
      const key = relKey(r);
      const existing = relMap.get(key);
      relMap.set(key, existing ? mergeRelation(existing, r) : r);
    }

    this.logger.log(
      `Hybrid extraction: regex=${regexResult.entities.length} entities, LLM=${allLlmEntities.length} entities, merged=${entityMap.size} entities`,
    );

    return {
      entities: Array.from(entityMap.values()),
      relations: Array.from(relMap.values()),
    };
  }

  /**
   * Persists extracted entities & relations to the database.
   * Merges duplicates gracefully.
   */
  async persistGraphElements(
    kbId: string,
    extracted: { entities: ExtractedEntity[]; relations: ExtractedRelation[] },
  ): Promise<{ entityCount: number; relationCount: number }> {
    const { entities, relations } = extracted;
    if (!entities.length) return { entityCount: 0, relationCount: 0 };

    const entityNameToId = new Map<string, string>();
    const entityContributions: Array<{ id: string; docId: string }> = [];

    // 0. Entity resolution. Surface forms of the same real-world entity (an
    //    abbreviation vs its full legal name, spacing/punctuation variants, the
    //    same person written with/without a title) used to become separate nodes, so
    //    relations landed on different nodes and the graph fragmented. Fold each
    //    incoming name into an existing canonical entity and remember the new
    //    surface form as an alias.
    const aliasToCanonical = await this.resolveEntityAliases(kbId, entities);
    const canonicalByName = new Map<string, ExtractedEntity>();
    for (const entity of entities) {
      const canonicalName = aliasToCanonical.get(entity.name) || entity.name;
      if (!canonicalByName.has(canonicalName)) {
        canonicalByName.set(canonicalName, { ...entity, name: canonicalName });
      }
    }

    // 1. Upsert entities in one round trip.
    //    The previous per-entity upsert was a serial N+1: a document with 200
    //    entities cost 200 round trips inside the ingestion worker. The batch
    //    statement keeps the "create or refresh type/description" semantics and
    //    returns every id in a single RETURNING set. Names are de-duplicated
    //    first because PostgreSQL rejects two rows touching the same conflict
    //    target in one statement.
    const uniqueEntities: typeof entities = [];
    const seenEntityNames = new Set<string>();
    const dedupedCanonical = Array.from(canonicalByName.values());
    for (let i = dedupedCanonical.length - 1; i >= 0; i -= 1) {
      const entity = dedupedCanonical[i];
      if (seenEntityNames.has(entity.name)) continue;
      seenEntityNames.add(entity.name);
      uniqueEntities.push(entity);
    }
    const entityPayload = uniqueEntities.map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description || null,
      properties: e.sourceDocId ? { docIds: [e.sourceDocId] } : {},
    }));
    const upserted: any[] = entityPayload.length
      ? await withServiceContext(this.prisma, (tx) => (tx as any).$queryRaw`
          INSERT INTO "GraphEntity" ("id", "kbId", "name", "type", "description", "aliases", "properties", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${kbId}::uuid, t.name, COALESCE(t.type, 'concept'), t.description,
                 '[]'::jsonb, COALESCE(t.properties, '{}'::jsonb), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          FROM jsonb_to_recordset(${JSON.stringify(entityPayload)}::jsonb)
            AS t(name text, type text, description text, properties jsonb)
          ON CONFLICT ("kbId", "name") DO UPDATE
            SET "type" = EXCLUDED."type",
                "description" = COALESCE(EXCLUDED."description", "GraphEntity"."description"),
                "properties" = COALESCE("GraphEntity"."properties", '{}'::jsonb)
                  || CASE WHEN EXCLUDED."properties"->'docIds' IS NULL
                          THEN '{}'::jsonb
                          ELSE jsonb_build_object(
                                 'docIds',
                                 COALESCE("GraphEntity"."properties"->'docIds', '[]'::jsonb)
                                   || (EXCLUDED."properties"->'docIds')
                               )
                     END,
                "updatedAt" = CURRENT_TIMESTAMP
          RETURNING "id", "name"
        `)
      : [];
    for (const row of upserted) {
      entityNameToId.set(String(row.name), String(row.id));
    }
    // Record the resolved surface forms as aliases of their canonical entity, and
    // let relations that referenced the alias resolve to the same id.
    const aliasPayload = new Map<string, string[]>();
    for (const [alias, canonicalName] of aliasToCanonical) {
      const canonicalId = entityNameToId.get(canonicalName);
      if (!canonicalId || alias === canonicalName) continue;
      entityNameToId.set(alias, canonicalId);
      const list = aliasPayload.get(canonicalId) || [];
      if (!list.includes(alias)) list.push(alias);
      aliasPayload.set(canonicalId, list);
    }
    if (aliasPayload.size) {
      const payload = Array.from(aliasPayload.entries()).map(([id, aliases]) => ({ id, aliases }));
      await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
        UPDATE "GraphEntity" AS entity
        SET "aliases" = (
          SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
          FROM jsonb_array_elements_text(
            COALESCE(entity."aliases", '[]'::jsonb) || contribution.aliases
          ) AS value
        ),
        "updatedAt" = CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS contribution(id text, aliases jsonb)
        WHERE entity."id"::text = contribution.id
      `);
    }
    const entityIdBySourceDoc = new Map<string, { id: string; docId: string }>();
    for (const e of uniqueEntities) {
      const id = entityNameToId.get(e.name);
      if (!id || !e.sourceDocId) continue;
      // One contribution per (entity, document): the merge below is a set
      // union, so repeating the same documentId would be wasted work.
      entityIdBySourceDoc.set(`${id}:${e.sourceDocId}`, { id, docId: e.sourceDocId });
    }
    entityContributions.push(...entityIdBySourceDoc.values());

    // Entity upsert must merge document provenance, not only set it on create.
    // Use one atomic SQL update for the whole batch to avoid both lost updates
    // and an additional per-entity read/update loop.
    if (entityContributions.length > 0) {
      await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
        UPDATE "GraphEntity" AS entity
        SET "properties" = jsonb_set(
          COALESCE(entity."properties", '{}'::jsonb),
          '{docIds}',
          COALESCE(entity."properties"->'docIds', '[]'::jsonb) || to_jsonb(contribution."docId"),
          true
        )
        FROM jsonb_to_recordset(${JSON.stringify(entityContributions)}::jsonb)
          AS contribution(id text, "docId" text)
        WHERE entity."id"::text = contribution.id
          AND NOT COALESCE(entity."properties"->'docIds', '[]'::jsonb)
            @> jsonb_build_array(contribution."docId")
      `);
    }

    // 2. Upsert relations in one round trip per batch.
    //    Relations that repeat inside the extraction window are merged here so
    //    the statement never touches the same conflict target twice (which
    //    PostgreSQL rejects), and the same weight cap (10) and provenance-union
    //    semantics as the previous per-row implementation are preserved.
    const RELATION_WEIGHT_CAP = 10;
    const relationKey = (sourceId: string, targetId: string, relationType: string): string =>
      `${sourceId}:${targetId}:${relationType}`;
    const relationBatch = new Map<
      string,
      {
        sourceId: string;
        targetId: string;
        relationType: string;
        weight: number;
        description: string | null;
        provenance: any[];
      }
    >();
    for (const r of relations) {
      const sourceId = entityNameToId.get(r.sourceName);
      const targetId = entityNameToId.get(r.targetName);
      if (!sourceId || !targetId || sourceId === targetId) continue;
      const key = relationKey(sourceId, targetId, r.relationType);
      const newProv = r.snippet
        ? {
            documentId: r.provenanceDocId,
            documentVersion: r.documentVersion || 1,
            chunkId: r.chunkId,
            snippet: r.snippet,
          }
        : null;
      const existing = relationBatch.get(key);
      if (existing) {
        if (newProv && !existing.provenance.some((p) => JSON.stringify(p) === JSON.stringify(newProv))) {
          existing.provenance.push(newProv);
        }
        continue;
      }
      relationBatch.set(key, {
        sourceId,
        targetId,
        relationType: r.relationType,
        weight: Math.min(Number(r.weight ?? 1.0), RELATION_WEIGHT_CAP),
        description: r.description || null,
        provenance: newProv ? [newProv] : [],
      });
    }

    const relationErrors: Error[] = [];
    let savedRelations = 0;
    const relationRows = Array.from(relationBatch.values());
    for (let i = 0; i < relationRows.length; i += 500) {
      const batch = relationRows.slice(i, i + 500);
      try {
        const saved: any[] = await withServiceContext(this.prisma, (tx) => (tx as any).$queryRaw`
          INSERT INTO "GraphRelation"
            ("id", "kbId", "sourceId", "targetId", "relationType", "weight", "description", "provenance", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${kbId}::uuid, t."sourceId"::uuid, t."targetId"::uuid,
                 t."relationType", t.weight, t.description, COALESCE(t.provenance, '[]'::jsonb),
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
            AS t("sourceId" text, "targetId" text, "relationType" text, weight float8,
                 description text, provenance jsonb)
          ON CONFLICT ("sourceId", "targetId", "relationType") DO UPDATE
            -- Weight expresses the strength of the strongest evidence seen for
            -- this edge, so re-extracting the same document (or reindexing it)
            -- must leave it unchanged. The previous weight + 0.5 rule made the
            -- number a reindex counter: after enough retries every edge saturated
            -- at the cap and ranking on weight became meaningless.
            SET "weight" = LEAST(
                  GREATEST("GraphRelation"."weight", EXCLUDED."weight"),
                  ${RELATION_WEIGHT_CAP}::float8
                ),
                "description" = COALESCE(EXCLUDED."description", "GraphRelation"."description"),
                "provenance" = CASE
                  WHEN COALESCE("GraphRelation"."provenance", '[]'::jsonb) @> COALESCE(EXCLUDED."provenance", '[]'::jsonb)
                    THEN COALESCE("GraphRelation"."provenance", '[]'::jsonb)
                  ELSE COALESCE("GraphRelation"."provenance", '[]'::jsonb)
                       || COALESCE(EXCLUDED."provenance", '[]'::jsonb)
                END,
                "updatedAt" = CURRENT_TIMESTAMP
          RETURNING "id"
        `);
        savedRelations += Array.isArray(saved) ? saved.length : 0;
      } catch (err: any) {
        const relationError = err instanceof Error ? err : new Error(String(err));
        relationErrors.push(relationError);
        this.logger.warn(
          `Failed to persist ${batch.length} graph relations in KB ${kbId}: ${err?.message || String(err)}`,
        );
      }
    }

    if (relationErrors.length > 0) {
      throw new AggregateError(
        relationErrors,
        `Failed to persist ${relationErrors.length}/${relations.length} graph relations in KB ${kbId}`,
      );
    }

    return {
      entityCount: entityMapSize(entityNameToId),
      relationCount: savedRelations,
    };
  }

  /**
   * Resolve incoming entity names against the entities already stored for this
   * knowledge base, returning a `surface form -> canonical name` map.
   *
   * Two rules, both conservative and configuration-gated:
   *  1. trigram similarity >= GRAPHRAG_ENTITY_ALIAS_THRESHOLD (default 0.86):
   *     catches spacing/punctuation/inflection variants of the same string;
   *  2. containment *with matching type* (an abbreviation inside the full legal
   *     name), which is how an abbreviation relates to a full name.
   *     The shorter name must be at least GRAPHRAG_ENTITY_ALIAS_MIN_CHARS (4)
   *     characters and at least 60% of the longer one, so a short title is not
   *     folded into a longer, distinct title that merely contains it.
   *
   * pg_trgm's GIN index on GraphEntity.name backs the candidate lookup
   * (migration 20260919100000_graph_search_indexes); the decision itself is made
   * here in TypeScript so it can be unit-tested.
   */
  private async resolveEntityAliases(
    kbId: string,
    entities: ExtractedEntity[],
  ): Promise<Map<string, string>> {
    const assignments = new Map<string, string>();
    if (process.env.GRAPHRAG_ENTITY_RESOLUTION === 'false') return assignments;
    const threshold = Number(process.env.GRAPHRAG_ENTITY_ALIAS_THRESHOLD || 0.86);
    const minChars = Math.max(4, Number(process.env.GRAPHRAG_ENTITY_ALIAS_MIN_CHARS || 4));
    const maxSeeds = Math.max(10, Number(process.env.GRAPHRAG_ENTITY_ALIAS_MAX_SEEDS || 300));
    const seeds = entities
      .map((e) => e.name)
      .filter((name) => typeof name === 'string' && name.trim().length >= minChars)
      .slice(0, maxSeeds);
    if (!seeds.length) return assignments;

    const typeByName = new Map(entities.map((e) => [e.name, e.type]));

    let candidates: any[] = [];
    try {
      candidates = (await withServiceContext(this.prisma, (tx) => (tx as any).$queryRaw`
        SELECT seed.name AS incoming,
               candidate.name AS canonical,
               candidate.type AS "canonicalType",
               similarity(candidate.name, seed.name) AS similarity
        FROM unnest(${seeds}::text[]) AS seed(name)
        JOIN LATERAL (
          SELECT e.name, e.type
          FROM "GraphEntity" e
          WHERE e."kbId" = ${kbId}::uuid
            AND e.name <> seed.name
            AND (e.name % seed.name
                 OR position(seed.name in e.name) > 0
                 OR position(e.name in seed.name) > 0)
          ORDER BY similarity(e.name, seed.name) DESC, length(e.name) ASC
          LIMIT 5
        ) AS candidate ON TRUE
        WHERE similarity(candidate.name, seed.name) >= ${Math.max(0.25, threshold - 0.4)}
           OR position(seed.name in candidate.name) > 0
           OR position(candidate.name in seed.name) > 0
      `)) || [];
    } catch (err) {
      this.logger.debug(
        `Entity alias candidate lookup failed (continuing without resolution): ${err instanceof Error ? err.message : String(err)}`,
      );
      return assignments;
    }

    const bestByIncoming = new Map<string, { canonical: string; similarity: number; accepted: boolean }>();
    for (const row of candidates) {
      const incoming = String(row.incoming);
      const canonical = String(row.canonical);
      const similarity = Number(row.similarity) || 0;
      const incomingType = typeByName.get(incoming);
      const typeCompatible = !incomingType || !row.canonicalType || incomingType === row.canonicalType;
      const shorter = incoming.length <= canonical.length ? incoming : canonical;
      const longer = incoming.length <= canonical.length ? canonical : incoming;
      // "X" vs "X有限公司": the abbreviation is the full base name plus a generic
      // Chinese legal-form suffix. Kept separate from the ratio rule below
      // because a legal-form suffix can be a large share of a short name
      // (5/9 = 0.56 for a typical "…有限公司"), which the ratio would reject.
      const legalFormSuffix = ['有限公司', '股份有限公司', '有限责任公司', '集团有限公司', '公司', '集团']
        .find((suffix) => longer.endsWith(suffix) && longer.slice(0, -suffix.length) === shorter);
      const contains =
        longer.includes(shorter) &&
        shorter.length >= minChars &&
        (shorter.length / longer.length >= 0.6 || Boolean(legalFormSuffix));
      const accepted = similarity >= threshold || (contains && typeCompatible);
      if (!accepted) continue;
      const previous = bestByIncoming.get(incoming);
      const score = similarity + (contains ? 0.1 : 0);
      const previousScore = previous ? previous.similarity + (previous.accepted ? 0.1 : 0) : -1;
      if (!previous || score > previousScore) {
        bestByIncoming.set(incoming, { canonical, similarity, accepted });
      }
    }

    for (const [incoming, match] of bestByIncoming) {
      if (incoming !== match.canonical) assignments.set(incoming, match.canonical);
    }
    if (assignments.size) {
      this.logger.log(
        `Entity resolution for KB ${kbId}: merged ${assignments.size} surface form(s) into canonical entities.`,
      );
    }
    return assignments;
  }

  /**
   * Removes graph elements contributed by a deleted/archived document so the
   * graph does not keep stale metadata. Two-phase cleanup:
   *   1. Delete every relation whose provenance (JSONB array of
   *      [{ documentId, documentVersion, chunkId, snippet }]) cites the
   *      document.
   *   2. Delete entities that are no longer referenced by any relation (no
   *      outgoing and no incoming edges), or whose own provenance
   *      (properties.docIds — the documents that contributed the entity)
   *      exclusively cites documents that are gone.
   * Idempotent: re-running for the same document removes nothing. All errors
   * are logged and swallowed so graph cleanup never breaks its caller.
   */
  async removeDocumentFromGraph(
    kbId: string,
    documentId: string,
  ): Promise<{ relationsRemoved: number; entitiesRemoved: number }> {
    const result = { relationsRemoved: 0, entitiesRemoved: 0 };
    try {
      // Phase 1 — relations. "provenance" is a JSONB column (migration
      // 20260907135700_add_graph_tables); the @> containment operator matches
      // whenever any provenance element carries the deleted documentId.
      result.relationsRemoved = await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
        WITH matched AS (
          SELECT relation."id",
            COALESCE((
              SELECT jsonb_agg(item)
              FROM jsonb_array_elements(relation."provenance") AS item
              WHERE item->>'documentId' <> ${documentId}
            ), '[]'::jsonb) AS remaining
          FROM "GraphRelation" AS relation
          WHERE relation."kbId" = ${kbId}::uuid
            AND relation."provenance" @> ${JSON.stringify([{ documentId }])}::jsonb
        ), updated AS (
          UPDATE "GraphRelation" AS relation
          SET "provenance" = matched.remaining
          FROM matched
          WHERE relation."id" = matched."id"
            AND jsonb_array_length(matched.remaining) > 0
          RETURNING relation."id"
        )
        DELETE FROM "GraphRelation" AS relation
        USING matched
        WHERE relation."id" = matched."id"
          AND jsonb_array_length(matched.remaining) = 0
      `);

      // Phase 2 — entities. Must run strictly after phase 1 so orphan
      // detection sees the post-cleanup edge set.
      result.entitiesRemoved = await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
        WITH provenance_updated AS (
          UPDATE "GraphEntity" AS entity
          SET "properties" = jsonb_set(
            COALESCE(entity."properties", '{}'::jsonb),
            '{docIds}',
            COALESCE((
              SELECT jsonb_agg(doc_id)
              FROM jsonb_array_elements_text(entity."properties"->'docIds') AS doc_ids(doc_id)
              WHERE doc_id <> ${documentId}
            ), '[]'::jsonb),
            true
          )
          WHERE entity."kbId" = ${kbId}::uuid
            AND COALESCE(entity."properties"->'docIds', '[]'::jsonb)
              @> jsonb_build_array(${documentId})
          RETURNING entity."id"
        )
        DELETE FROM "GraphEntity" AS e
        WHERE e."kbId" = ${kbId}::uuid
          AND (
            -- Orphans: no outgoing and no incoming relation left.
            NOT EXISTS (
              SELECT 1 FROM "GraphRelation" AS r
              WHERE r."sourceId" = e."id" OR r."targetId" = e."id"
            )
            OR (
              -- Entities whose remaining provenance is empty. The trailing
              -- edge check guards against cascade-deleting shared relations.
              jsonb_typeof(e."properties" -> 'docIds') = 'array'
              AND jsonb_array_length(e."properties" -> 'docIds') = 0
              AND NOT EXISTS (
                SELECT 1 FROM "GraphRelation" AS r
                WHERE r."sourceId" = e."id" OR r."targetId" = e."id"
              )
            )
          )
      `);

      if (result.relationsRemoved || result.entitiesRemoved) {
        this.logger.log(
          `Graph cleanup for document ${documentId} in KB ${kbId}: removed ${result.relationsRemoved} relation(s), ${result.entitiesRemoved} entity(ies).`,
        );
      }
      return result;
    } catch (err) {
      this.logger.warn(
        `Graph cleanup failed for document ${documentId} in KB ${kbId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }
  }

  /**
   * Builds communities and global summaries for a Knowledge Base (WeKnora GraphRAG Global Search).
   */
  async buildCommunitiesForKb(kbId: string, options?: { incremental?: boolean }): Promise<number> {
    const entities = await (this.prisma as any).graphEntity.findMany({
      where: { kbId },
      include: {
        outgoingRelations: {
          include: { target: true },
        },
        incomingRelations: {
          include: { source: true },
        },
      },
    });

    if (!entities.length) return 0;

    const entityById = new Map<string, any>(entities.map((e: any) => [e.id, e]));
    const communities = this.clusterEntitiesForCommunities(entities, entityById, kbId);

    if (!communities.length) return 0;

    return this.rebuildCommunitiesFromClusters(kbId, communities, options);
  }

  /**
   * Community detection for one knowledge base.
   *
   * Louvain (modularity) by default, because BFS connected components answer a
   * different question: a single long reference chain joins unrelated topics
   * into one component *and* the 30-node cap then silently dropped entities from
   * every community. BFS remains as the fallback for graphs above
   * GRAPHRAG_LOUVAIN_MAX_NODES (keeps one enrichment job bounded) and when
   * Louvain is switched off.
   */
  private clusterEntitiesForCommunities(
    entities: any[],
    entityById: Map<string, any>,
    kbId: string,
  ): Array<any[]> {
    const maxLouvainNodes = Math.max(100, Number(process.env.GRAPHRAG_LOUVAIN_MAX_NODES || 5000));
    const useLouvain =
      process.env.GRAPHRAG_COMMUNITY_ALGORITHM !== 'bfs' && entities.length <= maxLouvainNodes;

    if (useLouvain) {
      const nodes = entities.map((e: any) => String(e.id));
      const edges: Array<{ source: string; target: string; weight: number }> = [];
      for (const entity of entities) {
        for (const rel of entity.outgoingRelations || []) {
          if (!rel?.targetId || !entityById.has(rel.targetId)) continue;
          edges.push({
            source: String(entity.id),
            target: String(rel.targetId),
            weight: Number.isFinite(Number(rel.weight)) && Number(rel.weight) > 0 ? Number(rel.weight) : 1,
          });
        }
      }
      const result = detectCommunitiesLouvain(nodes, edges, {
        resolution: Number(process.env.GRAPHRAG_LOUVAIN_RESOLUTION || 1),
      });
      const minSize = Math.max(2, Number(process.env.GRAPHRAG_COMMUNITY_MIN_SIZE || 2));
      const clusters = result.communities
        .filter((members) => members.length >= minSize)
        .map((members) => members.map((id) => entityById.get(id)).filter(Boolean));
      if (clusters.length) {
        this.logger.log(
          `Louvain communities for KB ${kbId}: ${clusters.length} clusters, ${edges.length} edges, modularity ${result.modularity}, levels ${result.levels}`,
        );
        return clusters;
      }
      this.logger.warn(
        `Louvain produced no usable community for KB ${kbId}; falling back to connected components.`,
      );
    }

    return this.clusterEntitiesByConnectivity(entities, entityById);
  }

  /** Connected-component fallback (previous behaviour, kept for large graphs). */
  private clusterEntitiesByConnectivity(
    entities: any[],
    entityById: Map<string, any>,
  ): Array<any[]> {
    const visited = new Set<string>();
    const communities: Array<any[]> = [];
    const CLUSTER_CAP = Number(process.env.GRAPHRAG_COMMUNITY_CLUSTER_CAP || 60);

    for (const entity of entities) {
      if (visited.has(entity.id)) continue;
      const currentCluster: typeof entities = [];
      const queue: string[] = [entity.id];
      visited.add(entity.id);

      while (queue.length > 0) {
        if (currentCluster.length >= CLUSTER_CAP) {
          // Cap reached: entities still sitting in the queue were marked
          // visited but never joined a community. Roll back their visited
          // marks so the outer loop can seed the next BFS from them instead
          // of losing them from every community.
          for (const pendingId of queue) {
            visited.delete(pendingId);
          }
          queue.length = 0;
          break;
        }
        const currId = queue.shift()!;
        const curr = entityById.get(currId);
        if (!curr) continue;
        currentCluster.push(curr);

        for (const rel of curr.outgoingRelations || []) {
          if (rel.targetId && !visited.has(rel.targetId)) {
            visited.add(rel.targetId);
            queue.push(rel.targetId);
          }
        }
        for (const rel of curr.incomingRelations || []) {
          if (rel.sourceId && !visited.has(rel.sourceId)) {
            visited.add(rel.sourceId);
            queue.push(rel.sourceId);
          }
        }
      }
      if (currentCluster.length >= 2) {
        communities.push(currentCluster);
      }
    }

    return communities;
  }

  /**
   * Persist a clustering result: reuse unchanged communities (incremental) or
   * rebuild the whole set, then regenerate the level-1 hierarchy.
   */
  private async rebuildCommunitiesFromClusters(
    kbId: string,
    communities: Array<any[]>,
    options?: { incremental?: boolean },
  ): Promise<number> {

    if (options?.incremental) {
      // Incremental Community Self-Healing:
      // Compare newly computed clusters against existing communities in database.
      // Re-use intact communities to avoid duplicate LLM/Embedding calls and DB thrashing.
      const existing = await (this.prisma as any).graphCommunity.findMany({ where: { kbId } });
      const existingMap = new Map<string, any>();
      for (const comm of existing || []) {
        const key = Array.isArray(comm.entityIds) ? [...comm.entityIds].sort().join(",") : "";
        if (key) existingMap.set(key, comm);
      }

      const keptCommunityIds = new Set<string>();
      const clustersToCreate: Array<any[]> = [];

      for (const cluster of communities) {
        const key = cluster.map((e: any) => e.id).sort().join(",");
        const matched = existingMap.get(key);
        if (matched) {
          keptCommunityIds.add(matched.id);
        } else {
          clustersToCreate.push(cluster);
        }
      }

      // Delete only obsolete communities that were modified or merged
      const toDelete = (existing || []).filter((c: any) => !keptCommunityIds.has(c.id)).map((c: any) => c.id);
      if (toDelete.length > 0) {
        await (this.prisma as any).graphCommunity.deleteMany({
          where: { id: { in: toDelete } },
        });
      }

      let created = keptCommunityIds.size;
      const createdCommunities: Array<{ id: string; text: string }> = [];
      for (let i = 0; i < clustersToCreate.length; i++) {
        const cluster = clustersToCreate[i];
        const titles = cluster.map((e: any) => e.name);
        const mainTitle = titles.slice(0, 3).join(" / ") + ` (增量社区 ${created + 1})`;
        const { summary, findings } = await this.summarizeCommunity(cluster, mainTitle);

        const comm = await (this.prisma as any).graphCommunity.create({
          data: {
            kbId,
            title: mainTitle,
            level: 0,
            summary,
            entityIds: cluster.map((e: any) => e.id),
            findings,
          },
        });
        createdCommunities.push({ id: comm.id, text: `${mainTitle}\n${summary}` });
        created++;
      }

      if (this.embeddingService?.isEnabled() && createdCommunities.length) {
        try {
          const vectors = await this.embeddingService.embed(createdCommunities.map((c) => c.text.slice(0, 4000)));
          for (let i = 0; i < createdCommunities.length; i++) {
            const vector = vectors[i];
            if (!vector) continue;
            await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
              UPDATE "GraphCommunity" SET embedding = ${`[${vector.join(",")}]`}::vector
              WHERE id = ${createdCommunities[i].id}::uuid
            `);
          }
        } catch (err) {
          this.logger.debug(`Community embedding skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.logger.log(`Incrementally healed ${created} GraphRAG communities for KB ${kbId} (created ${clustersToCreate.length}, pruned ${toDelete.length})`);
      await this.rebuildCommunityHierarchy(kbId).catch((err) => {
        this.logger.warn(
          `Community hierarchy rebuild failed for KB ${kbId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return created;
    }

    // Default full rebuild mode (100% backward compatible with unit tests)
    // Clean old communities for this KB
    await (this.prisma as any).graphCommunity.deleteMany({ where: { kbId } });

    let created = 0;
    const createdCommunities: Array<{ id: string; text: string }> = [];
    for (let i = 0; i < communities.length; i++) {
      const cluster = communities[i];
      const titles = cluster.map((e: any) => e.name);
      const mainTitle = titles.slice(0, 3).join(' / ') + ` (社区 ${i + 1})`;
      const { summary, findings } = await this.summarizeCommunity(cluster, mainTitle);

      const comm = await (this.prisma as any).graphCommunity.create({
        data: {
          kbId,
          title: mainTitle,
          level: 0,
          summary,
          entityIds: cluster.map((e: any) => e.id),
          findings,
        },
      });
      createdCommunities.push({ id: comm.id, text: `${mainTitle}\n${summary}` });
      created++;
    }

    // Vectorize community summaries so global search ranks by cosine recall
    // instead of raw keyword overlap. Fail-open: keyword ranking keeps working
    // when the embedding provider is unavailable.
    if (this.embeddingService?.isEnabled() && createdCommunities.length) {
      try {
        const vectors = await this.embeddingService.embed(createdCommunities.map((c) => c.text.slice(0, 4000)));
        for (let i = 0; i < createdCommunities.length; i++) {
          const vector = vectors[i];
          if (!vector) continue;
          await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
            UPDATE "GraphCommunity" SET embedding = ${`[${vector.join(',')}]`}::vector
            WHERE id = ${createdCommunities[i].id}::uuid
          `);
        }
      } catch (err) {
        this.logger.debug(`Community embedding skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Hierarchical roll-up: summarise the level-0 communities themselves so
    // macro questions ("what are the main themes across all of this?") can be
    // answered from a coarser layer instead of concatenating every micro
    // community summary.
    await this.rebuildCommunityHierarchy(kbId).catch((err) => {
      this.logger.warn(
        `Community hierarchy rebuild failed for KB ${kbId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.logger.log(`Built ${created} GraphRAG communities for KB ${kbId}`);
    return created;
  }

  /**
   * Summarise one community.
   *
   * This used to be a template string that just listed entity names and types
   * ("本知识社区涵盖了以下核心实体：A、B、C ..."), which is not a summary: it
   * carries no relation between the entities, so global search could only match
   * it on entity names that the vector arm already matched directly. The LLM
   * path writes an actual narrative over entities *and* relations; the template
   * remains as the fail-open fallback when no LLM route is configured.
   *
   * Cost is bounded by the incremental reuse above (unchanged communities are
   * never re-summarised) and by GRAPHRAG_COMMUNITY_SUMMARY_LLM.
   */
  private async summarizeCommunity(
    cluster: any[],
    title: string,
  ): Promise<{ summary: string; findings: string[] }> {
    const titles = cluster.map((e: any) => e.name);
    const types = [...new Set(cluster.map((e: any) => e.type))];
    const fallbackSummary = `本知识社区涵盖了以下核心实体：${titles.slice(0, 10).join('、')}。涵盖领域类别：${types.join('、')}。涉及制度引用与系统实体间的相互协作、归属与管理关系。`;
    const fallbackFindings = [
      `核心实体：${titles.slice(0, 5).join(', ')}`,
      `实体总数：${cluster.length} 个`,
    ];

    if (process.env.GRAPHRAG_COMMUNITY_SUMMARY_LLM === 'false') {
      return { summary: fallbackSummary, findings: fallbackFindings };
    }

    try {
      const config = await this.getLlmConfig();
      if (!config) return { summary: fallbackSummary, findings: fallbackFindings };

      const entityLines = cluster
        .slice(0, 40)
        .map((e: any) => `- ${e.name}（${e.type}）${e.description ? `：${String(e.description).slice(0, 120)}` : ''}`);
      const relationLines: string[] = [];
      for (const entity of cluster.slice(0, 40)) {
        for (const rel of entity.outgoingRelations || []) {
          const target = rel?.target?.name || rel?.targetId;
          if (!target) continue;
          const snippet = Array.isArray(rel.provenance) && rel.provenance[0]?.snippet
            ? `（依据：${String(rel.provenance[0].snippet).slice(0, 80)}）`
            : '';
          relationLines.push(`- ${entity.name} --[${rel.relationType}]--> ${target}${snippet}`);
          if (relationLines.length >= 40) break;
        }
        if (relationLines.length >= 40) break;
      }

      const prompt = `以下是一个知识图谱社区（领域聚类）的实体与关系。请写一段 120-200 字的领域综述，说明这个社区在讲什么、实体之间如何关联、以及可以回答哪一类问题；再给出 2-4 条关键发现。必须只依据给定内容，不要补充外部知识。只输出 JSON：{"summary":"...","findings":["..."]}。

社区标题：${title}
实体：
${entityLines.join('\n')}
关系：
${relationLines.length ? relationLines.join('\n') : '（无显式关系）'}`;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelName,
          messages: [
            { role: 'system', content: '你是知识图谱社区摘要专家。只输出合法 JSON，不要输出其他内容。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: Number(process.env.GRAPHRAG_COMMUNITY_SUMMARY_MAX_TOKENS || 700),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Number(process.env.GRAPHRAG_COMMUNITY_SUMMARY_TIMEOUT_MS || 20000)),
      });
      if (!response.ok) return { summary: fallbackSummary, findings: fallbackFindings };
      const payload: any = await response.json();
      const message = payload?.choices?.[0]?.message || {};
      let content = String(message.content || '').trim();
      if (!content) content = String(message.reasoning_content || '').trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { summary: fallbackSummary, findings: fallbackFindings };
      const parsed = JSON.parse(jsonMatch[0]);
      const summary = typeof parsed?.summary === 'string' && parsed.summary.trim().length >= 20
        ? parsed.summary.trim()
        : fallbackSummary;
      const findings = Array.isArray(parsed?.findings)
        ? parsed.findings.map((f: any) => String(f)).filter((f: string) => f.trim()).slice(0, 6)
        : fallbackFindings;
      return { summary, findings: findings.length ? findings : fallbackFindings };
    } catch (err) {
      this.logger.debug(
        `Community LLM summary failed, using template fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { summary: fallbackSummary, findings: fallbackFindings };
    }
  }

  /**
   * Build the level-1 layer from the level-0 communities: nodes become
   * communities, an edge weight becomes the summed weight of the relations that
   * cross between them, and Louvain runs again on that coarsened graph. Each
   * level-0 community is then linked to its parent.
   *
   * Idempotent: existing level-1 rows are replaced on every call.
   */
  private async rebuildCommunityHierarchy(kbId: string): Promise<number> {
    if (process.env.GRAPHRAG_COMMUNITY_HIERARCHY === 'false') return 0;

    const level0: any[] = (await (this.prisma as any).graphCommunity.findMany({
      where: { kbId, level: 0 },
      select: { id: true, title: true, summary: true, entityIds: true },
    })) || [];
    await (this.prisma as any).graphCommunity.deleteMany({ where: { kbId, level: { gt: 0 } } });
    if (level0.length < 2) return 0;

    const entityToCommunity = new Map<string, string>();
    for (const community of level0) {
      for (const entityId of Array.isArray(community.entityIds) ? community.entityIds : []) {
        entityToCommunity.set(String(entityId), String(community.id));
      }
    }

    const relations: any[] = (await (this.prisma as any).graphRelation.findMany({
      where: { kbId },
      select: { sourceId: true, targetId: true, weight: true },
    })) || [];
    const edgeWeights = new Map<string, number>();
    for (const rel of relations) {
      const source = entityToCommunity.get(String(rel.sourceId));
      const target = entityToCommunity.get(String(rel.targetId));
      if (!source || !target || source === target) continue;
      const key = source < target ? `${source}|${target}` : `${target}|${source}`;
      edgeWeights.set(key, (edgeWeights.get(key) || 0) + (Number(rel.weight) || 1));
    }

    const detect = detectCommunitiesLouvain(
      level0.map((c) => String(c.id)),
      Array.from(edgeWeights.entries()).map(([key, weight]) => {
        const [source, target] = key.split('|');
        return { source, target, weight };
      }),
      { resolution: Number(process.env.GRAPHRAG_LOUVAIN_RESOLUTION || 1) },
    );

    const communityById = new Map(level0.map((c) => [String(c.id), c]));
    let created = 0;
    for (const members of detect.communities) {
      if (members.length < 2) continue;
      const children = members.map((id) => communityById.get(id)).filter(Boolean);
      const titles = children.map((c: any) => c.title);
      const title = `领域总览：${titles.slice(0, 3).join(' / ')}`;
      const { summary, findings } = await this.summarizeCommunity(
        children.map((c: any) => ({
          name: c.title,
          type: 'community',
          description: String(c.summary || '').slice(0, 200),
          outgoingRelations: [],
        })),
        title,
      );
      const parent = await (this.prisma as any).graphCommunity.create({
        data: {
          kbId,
          title,
          level: 1,
          summary,
          entityIds: children.flatMap((c: any) => (Array.isArray(c.entityIds) ? c.entityIds : [])),
          findings,
        },
      });
      created += 1;
      if (this.embeddingService?.isEnabled()) {
        try {
          const vector = await this.embeddingService.embedOne(`${title}\n${summary}`);
          if (vector?.length) {
            await withServiceContext(this.prisma, (tx) => (tx as any).$executeRaw`
              UPDATE "GraphCommunity" SET embedding = ${`[${vector.join(',')}]`}::vector WHERE id = ${parent.id}::uuid
            `);
          }
        } catch {
          // fail-open: keyword ranking still works without an embedding
        }
      }
      await (this.prisma as any).graphCommunity.updateMany({
        where: { id: { in: members } },
        data: { parentCommunityId: parent.id },
      });
    }

    this.logger.log(`Built ${created} level-1 GraphRAG communities for KB ${kbId}`);
    return created;
  }

  /**
   * Universal token extraction for GraphRAG query matching.
   * Works across Chinese, English and multi-lingual phrases without hardcoded dictionaries.
   */
  private extractQueryTerms(query: string): string[] {
    const stopWords = new Set([
      '什么', '怎么', '如何', '哪些', '请问', '是否', '要求', '规范', '规定',
      '情况', '一下', '这个', '那个', '因为', '所以', '以及', '或者', '关系', '是什么', '有哪些', '包括哪些',
      'what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how', 'does', 'with', 'from', 'about',
    ]);

    const meaningfulWords: string[] = [];

    // 1. Intl.Segmenter word segmentation (standard in modern Node.js / V8)
    if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
      try {
        const segmenter = new (Intl as any).Segmenter('zh-CN', { granularity: 'word' });
        const segments = [...segmenter.segment(query)].filter((s: any) => s.isWordLike).map((s: any) => s.segment);
        for (let i = 0; i < segments.length; i++) {
          const w = segments[i];
          if (w.length >= 2 && !stopWords.has(w.toLowerCase())) {
            meaningfulWords.push(w);
          }
          if (i + 1 < segments.length) {
            const combined = w + segments[i + 1];
            if (combined.length >= 2 && combined.length <= 8 && !stopWords.has(combined.toLowerCase())) {
              meaningfulWords.push(combined);
            }
          }
        }
      } catch {
        // Fallback to punctuation splitting
      }
    }

    // 2. Standard punctuation & delimiter split
    for (const t of query.split(/[\s,，、。！？?；;:：()（）《》「」“”"']+/u)) {
      if (t.length >= 2 && t.length <= 20 && !stopWords.has(t.toLowerCase())) {
        meaningfulWords.push(t);
      }
    }

    // 3. Sliding 2-4 grams for compact phrases
    const clean = query.replace(/[^\p{L}\p{N}]/gu, '');
    if (clean.length <= 20) {
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= clean.length - len; i++) {
          const gram = clean.slice(i, i + len);
          if (!stopWords.has(gram.toLowerCase())) {
            meaningfulWords.push(gram);
          }
        }
      }
    }

    const unique = Array.from(new Set(meaningfulWords));
    return unique.slice(0, 15);
  }

  /**
   * GraphRAG Local Search: matches question entities (by canonical name or
   * alias), returns their direct relations, and expands a bounded 2-hop
   * neighbourhood for indirect connections — the doc comment previously claimed
   * 2-hop while the implementation only ever emitted 1-hop edges.
   */
  async searchLocalGraph(
    kbIds: string[],
    query: string,
    limit = 10,
  ): Promise<LocalGraphSearchResult> {
    if (!kbIds.length || !query.trim()) {
      return { entities: [], relations: [], formattedContext: '' };
    }

    // 1. Identify entities mentioned in the query
    const terms = this.extractQueryTerms(query);

    if (!terms.length) {
      return { entities: [], relations: [], formattedContext: '' };
    }

    const isDocCatalogQuery = /(哪些.*(文档|知识|制度|资料)|(文档|知识|制度|资料).*哪些|(文档|制度).*(列表|清单|目录|全景)|(所有|全部).*(文档|制度))/u.test(query);
    // Match the canonical name AND the aliases recorded by entity resolution, so
    // a question using the abbreviation still reaches the canonical node.
    const orConditions: any[] = [];
    for (const term of terms) {
      orConditions.push({ name: { contains: term, mode: 'insensitive' } });
      orConditions.push({ aliases: { array_contains: [term] } });
    }
    if (isDocCatalogQuery) {
      orConditions.push({ type: 'document' });
    }

    // Search matching entities across visible KBs
    const entities = await (this.prisma as any).graphEntity.findMany({
      where: {
        kbId: { in: kbIds },
        OR: orConditions,
      },
      take: isDocCatalogQuery ? Math.max(limit, 25) : limit,
      include: {
        outgoingRelations: {
          take: 5,
          include: { target: true },
        },
        incomingRelations: {
          take: 5,
          include: { source: true },
        },
      },
    });

    if (!entities.length) {
      return { entities: [], relations: [], formattedContext: '' };
    }

    // 2-hop expansion of the *neighbourhood* (see the contract in the method
    // doc comment). The 1-hop relations are already loaded above; this adds the
    // neighbours' own relations so an indirect connection (A -> B -> C) is
    // visible to the answer instead of stopping at the first hop.
    const maxTwoHopEntities = Math.max(0, Number(process.env.GRAPHRAG_LOCAL_2HOP_MAX || 6));
    let twoHopRelations: any[] = [];
    if (maxTwoHopEntities > 0) {
      const firstHopIds = new Set<string>();
      for (const entity of entities) {
        for (const rel of entity.outgoingRelations || []) if (rel.targetId) firstHopIds.add(String(rel.targetId));
        for (const rel of entity.incomingRelations || []) if (rel.sourceId) firstHopIds.add(String(rel.sourceId));
      }
      const directIds = new Set(entities.map((e: any) => String(e.id)));
      const frontier = Array.from(firstHopIds).filter((id) => !directIds.has(id)).slice(0, maxTwoHopEntities);
      if (frontier.length) {
        try {
          twoHopRelations = (await (this.prisma as any).graphRelation.findMany({
            where: {
              kbId: { in: kbIds },
              OR: [
                { sourceId: { in: frontier }, targetId: { notIn: directIds.size ? Array.from(directIds) : [] } },
                { targetId: { in: frontier }, sourceId: { notIn: directIds.size ? Array.from(directIds) : [] } },
              ],
            },
            take: Math.max(5, limit),
            include: { source: { select: { name: true, type: true } }, target: { select: { name: true, type: true } } },
          })) || [];
        } catch (err) {
          this.logger.debug(
            `Graph 2-hop expansion failed (returning 1-hop only): ${err instanceof Error ? err.message : String(err)}`,
          );
          recordFailopen('graph');
        }
      }
    }

    const relationsList: Array<{
      source: string;
      target: string;
      relationType: string;
      weight: number;
      snippet?: string;
      provenance: Array<{
        documentId?: string;
        documentVersion?: number;
        chunkId?: string;
        snippet?: string;
      }>;
    }> = [];

    const contextLines: string[] = [];
    contextLines.push('【知识图谱关联事实 (GraphRAG Local Search)】');

    if (isDocCatalogQuery) {
      const docEntities = entities.filter((e: any) => e.type === 'document');
      if (docEntities.length) {
        contextLines.push('【权限范围内可见的知识库文档 (GraphRAG 知识实体清单)】:');
        for (const doc of docEntities) {
          contextLines.push(`- 可见文档: 《${doc.name}》`);
        }
      }
    }

    const supersededEntityNames = new Set<string>();
    const temporalWarnings: string[] = [];

    // First pass: identify any temporal superseding / repeal relations
    for (const entity of entities) {
      for (const rel of entity.outgoingRelations || []) {
        if (rel.relationType === 'supersedes' && rel.target?.name) {
          supersededEntityNames.add(rel.target.name);
          temporalWarnings.push(`- ⚠️【时序效力裁决】: [${rel.target.name}] 已被现行规范 [${entity.name}] 替代废止，相关历史条款已失效，请以现行规范为准。`);
        }
      }
      for (const rel of entity.incomingRelations || []) {
        if (rel.relationType === 'supersedes' && rel.source?.name) {
          supersededEntityNames.add(entity.name);
          temporalWarnings.push(`- ⚠️【时序效力裁决】: [${entity.name}] 已被现行规范 [${rel.source.name}] 替代废止，相关历史条款已失效，请以现行规范为准。`);
        }
      }
    }

    if (temporalWarnings.length) {
      contextLines.push('【时序版本效力状态】:');
      contextLines.push(...new Set(temporalWarnings));
    }

    for (const entity of entities) {
      const isSuperseded = supersededEntityNames.has(entity.name);
      for (const rel of entity.outgoingRelations || []) {
        // Demote or skip relations originating from a superseded entity unless it's a supersedes relation itself
        if (isSuperseded && rel.relationType !== 'supersedes') continue;
        relationsList.push({
          source: entity.name,
          target: rel.target.name,
          relationType: rel.relationType,
          weight: isSuperseded ? rel.weight * 0.3 : rel.weight,
          snippet: (rel.provenance as any)?.[0]?.snippet,
          provenance: Array.isArray(rel.provenance) ? rel.provenance : [],
        });
        const snippetInfo = (rel.provenance as any)?.[0]?.snippet ? ` (依据: "${(rel.provenance as any)[0].snippet}")` : '';
        const statusTag = isSuperseded ? ' [已废止]' : '';
        contextLines.push(`- [${entity.name}${statusTag}] (${entity.type}) --[${rel.relationType}]--> [${rel.target.name}] (${rel.target.type})${snippetInfo}`);
      }
      for (const rel of entity.incomingRelations || []) {
        const sourceSuperseded = supersededEntityNames.has(rel.source.name);
        if (sourceSuperseded && rel.relationType !== 'supersedes') continue;
        relationsList.push({
          source: rel.source.name,
          target: entity.name,
          relationType: rel.relationType,
          weight: sourceSuperseded ? rel.weight * 0.3 : rel.weight,
          snippet: (rel.provenance as any)?.[0]?.snippet,
          provenance: Array.isArray(rel.provenance) ? rel.provenance : [],
        });
        const snippetInfo = (rel.provenance as any)?.[0]?.snippet ? ` (依据: "${(rel.provenance as any)[0].snippet}")` : '';
        const statusTag = sourceSuperseded ? ' [已废止]' : '';
        contextLines.push(`- [${rel.source.name}${statusTag}] (${rel.source.type}) --[${rel.relationType}]--> [${entity.name}] (${entity.type})${snippetInfo}`);
      }
    }

    // Indirect (2-hop) relations: marked so the answer can distinguish a direct
    // fact from a connection that is one link away, and capped so a hub entity
    // cannot flood the context.
    const indirectLines: string[] = [];
    for (const rel of twoHopRelations) {
      const sourceName = rel?.source?.name;
      const targetName = rel?.target?.name;
      if (!sourceName || !targetName) continue;
      const snippet = (rel.provenance as any)?.[0]?.snippet;
      const snippetInfo = snippet ? ` (依据: "${String(snippet).slice(0, 120)}")` : '';
      indirectLines.push(
        `- (间接) [${sourceName}] (${rel.source?.type || 'concept'}) --[${rel.relationType}]--> [${targetName}] (${rel.target?.type || 'concept'})${snippetInfo}`,
      );
      if (indirectLines.length >= 8) break;
    }
    if (indirectLines.length) {
      contextLines.push('【间接关联（两跳）】:');
      contextLines.push(...indirectLines);
    }

    return {
      entities: entities.map((e: any) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
      })),
      relations: relationsList,
      formattedContext: contextLines.length > 1 ? contextLines.slice(0, 24).join('\n') : '',
    };
  }

  /**
   * Chunks that the knowledge graph associates with the entities mentioned in
   * the question: direct relations first, then a bounded 2-hop neighbourhood.
   *
   * This is the retrieval-side contract of the graph arm — it returns chunk ids
   * (not prose) so the caller can fetch them under the same ACL/published gate
   * as every other channel and fuse them by rank with lexical and vector
   * retrieval. Chunks are scored by the strongest relation weight that cites
   * them, and a chunk cited by several related relations accumulates score.
   */
  async searchRelatedChunkIds(
    kbIds: string[],
    query: string,
    limit = 20,
  ): Promise<Array<{ chunkId: string; documentId: string | null; score: number; hops: number }>> {
    if (!kbIds.length || !query?.trim()) return [];
    const terms = this.extractQueryTerms(query);
    if (!terms.length) return [];

    const orConditions: any[] = [];
    for (const term of terms) {
      orConditions.push({ name: { contains: term, mode: 'insensitive' } });
      orConditions.push({ aliases: { array_contains: [term] } });
    }

    try {
      const matched: any[] = (await (this.prisma as any).graphEntity.findMany({
        where: { kbId: { in: kbIds }, OR: orConditions },
        select: { id: true, name: true, outgoingRelations: { select: { targetId: true } }, incomingRelations: { select: { sourceId: true } } },
        take: Math.max(5, Number(process.env.GRAPHRAG_ARM_SEED_ENTITIES || 12)),
      })) || [];
      if (!matched.length) return [];

      const directIds = new Set(matched.map((e: any) => String(e.id)));
      const neighbourIds = new Set<string>();
      for (const entity of matched) {
        for (const rel of entity.outgoingRelations || []) if (rel.targetId) neighbourIds.add(String(rel.targetId));
        for (const rel of entity.incomingRelations || []) if (rel.sourceId) neighbourIds.add(String(rel.sourceId));
      }
      for (const id of directIds) neighbourIds.delete(id);

      const maxNeighbours = Math.max(0, Number(process.env.GRAPHRAG_ARM_2HOP_ENTITIES || 8));
      const relatedEntityIds = Array.from(neighbourIds).slice(0, maxNeighbours);
      const seedIds = Array.from(directIds);

      const entityGroup = (ids: string[], hops: number) => ({ ids, hops });
      const groups = [entityGroup(seedIds, 1), entityGroup(relatedEntityIds, 2)].filter((g) => g.ids.length);

      const scores = new Map<string, { documentId: string | null; score: number; hops: number }>();
      // A relation can be returned by both the seed group and the neighbour
      // group (its endpoints are a seed and a neighbour), which would count its
      // weight twice. Track the relations already scored.
      const seenRelationIds = new Set<string>();
      for (const group of groups) {
        const relations: any[] = (await (this.prisma as any).graphRelation.findMany({
          where: {
            kbId: { in: kbIds },
            OR: [{ sourceId: { in: group.ids } }, { targetId: { in: group.ids } }],
          },
          select: { id: true, weight: true, provenance: true },
          take: Math.max(20, limit * 4),
        })) || [];

        for (const relation of relations) {
          const relationId = relation?.id ? String(relation.id) : null;
          if (relationId) {
            if (seenRelationIds.has(relationId)) continue;
            seenRelationIds.add(relationId);
          }
          const provenance = Array.isArray(relation.provenance) ? relation.provenance : [];
          for (const entry of provenance) {
            const chunkId = entry?.chunkId || entry?.chunk_id;
            if (!chunkId) continue;
            const weight = Number.isFinite(Number(relation.weight)) ? Number(relation.weight) : 1;
            const key = String(chunkId);
            const previous = scores.get(key);
            if (!previous) {
              scores.set(key, { documentId: entry?.documentId ? String(entry.documentId) : null, score: weight, hops: group.hops });
              continue;
            }
            previous.score += weight;
            previous.hops = Math.min(previous.hops, group.hops);
          }
        }
      }

      return Array.from(scores.entries())
        .map(([chunkId, value]) => ({ chunkId, ...value }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.hops !== b.hops) return a.hops - b.hops;
          return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
        })
        .slice(0, Math.max(1, limit));
    } catch (err) {
      this.logger.debug(
        `Graph chunk-arm lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      recordFailopen('graph');
      return [];
    }
  }

  /**
   * GraphRAG Global Search: retrieves community summaries across authorized KBs.
   */
  async searchGlobalCommunities(
    kbIds: string[],
    query: string,
    limit = 3,
  ): Promise<GlobalCommunitySearchResult> {
    if (!kbIds.length) {
      return { communities: [], formattedContext: '' };
    }

    // Vector recall over embedded community summaries first; keyword overlap
    // remains the fallback for un-embedded rows / disabled provider.
    if (this.embeddingService?.isEnabled()) {
      try {
        const vector = await this.embeddingService.embedOne(query);
        if (vector && vector.length) {
          const literal = `[${vector.join(',')}]`;
          const rows = await withServiceContext(this.prisma, (tx) => (tx as any).$queryRaw<any[]>`
            SELECT id, title, summary, findings,
                   1 - (embedding <=> ${literal}::vector) AS similarity
            FROM "GraphCommunity"
            WHERE "kbId" = ANY(${kbIds}::uuid[]) AND embedding IS NOT NULL
            ORDER BY embedding <=> ${literal}::vector
            LIMIT ${Math.max(limit * 2, 6)}
          `);
          const hits = (rows || []).filter((row: any) => Number(row.similarity) >= Number(process.env.GRAPHRAG_VECTOR_MIN_SCORE || 0.30));
          if (hits.length) {
            const selected = hits.slice(0, limit);
            const contextLines: string[] = ['【知识图谱社区宏观摘要 (GraphRAG Global Search)】'];
            for (const c of selected) {
              contextLines.push(`### 领域社区: ${c.title}\n${c.summary}`);
            }
            return {
              communities: selected.map((c: any) => ({
                id: c.id,
                title: c.title,
                summary: c.summary,
                findings: Array.isArray(c.findings) ? c.findings : [],
              })),
              formattedContext: contextLines.join('\n\n'),
            };
          }
        }
      } catch (err) {
        this.logger.debug(`Community vector search unavailable: ${err instanceof Error ? err.message : String(err)}`);
        recordFailopen('graph');
      }
    }

    const communities = await (this.prisma as any).graphCommunity.findMany({
      where: { kbId: { in: kbIds } },
      take: limit * 3,
      orderBy: { updatedAt: 'desc' },
    });

    if (!communities.length) {
      return { communities: [], formattedContext: '' };
    }

    // Rank communities by keyword overlap
    const terms = query.split(/[\s,，、。！？?；;:：]+/u).filter((t) => t.length >= 2);
    const scored = communities.map((comm: any) => {
      let score = 0;
      for (const t of terms) {
        if (comm.title.includes(t)) score += 3;
        if (comm.summary.includes(t)) score += 1;
      }
      return { comm, score };
    }).sort((a: any, b: any) => b.score - a.score);

    const selected = scored.filter((s: any) => s.score > 0).slice(0, limit).map((s: any) => s.comm);
    const contextLines: string[] = [];
    if (selected.length) {
      contextLines.push('【知识图谱社区宏观摘要 (GraphRAG Global Search)】');
      for (const c of selected) {
        contextLines.push(`### 领域社区: ${c.title}\n${c.summary}`);
      }
    }

    return {
      communities: selected.map((c: any) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        findings: Array.isArray(c.findings) ? c.findings : [],
      })),
      formattedContext: contextLines.join('\n\n'),
    };
  }

  /**
   * Bounded DRIFT navigation plan.
   *
   * Community summaries are machine-written navigation aids and never become
   * answer facts. They select a small set of graph communities; canonical
   * entity names from those communities become ordinary retrieval probes whose
   * results must resolve back to published source chunks.
   */
  async planDriftQueries(
    kbIds: string[],
    query: string,
    options: { maxCommunities?: number; maxProbes?: number; maxEntities?: number } = {},
  ): Promise<DriftSearchPlan> {
    const empty: DriftSearchPlan = { probes: [], communityIds: [], seedEntities: [] };
    if (!kbIds.length || !query.trim()) return empty;
    const maxCommunities = Math.max(1, Math.min(options.maxCommunities || 2, 4));
    const maxProbes = Math.max(1, Math.min(options.maxProbes || 2, 4));
    const maxEntities = Math.max(maxProbes, Math.min(options.maxEntities || 16, 40));

    try {
      const global = await this.searchGlobalCommunities(kbIds, query, maxCommunities);
      const communityIds = global.communities.map((community) => String(community.id)).filter(Boolean);
      if (!communityIds.length) return empty;

      const communities: any[] = (await (this.prisma as any).graphCommunity.findMany({
        where: { id: { in: communityIds }, kbId: { in: kbIds } },
        select: { id: true, title: true, entityIds: true },
        take: maxCommunities,
      })) || [];
      const entityIds = [...new Set(
        communities.flatMap((community) => Array.isArray(community.entityIds) ? community.entityIds.map(String) : []),
      )].slice(0, maxEntities);
      if (!entityIds.length) return { probes: [], communityIds, seedEntities: [] };

      const entities: any[] = (await (this.prisma as any).graphEntity.findMany({
        where: { id: { in: entityIds }, kbId: { in: kbIds } },
        select: { id: true, name: true, type: true },
        take: maxEntities,
      })) || [];
      const normalizedQuery = query.toLowerCase();
      const seedEntities = entities
        .map((entity) => String(entity.name || '').trim())
        .filter((name) => name.length >= 2 && !normalizedQuery.includes(name.toLowerCase()))
        .slice(0, maxEntities);

      // Pair community context with a canonical entity name. This gives the
      // downstream lexical/dense/graph channels enough specificity without
      // treating the generated community summary as evidence.
      const probes: string[] = [];
      for (const community of communities) {
        const ids = new Set((Array.isArray(community.entityIds) ? community.entityIds : []).map(String));
        const names = entities
          .filter((entity) => ids.has(String(entity.id)))
          .map((entity) => String(entity.name || '').trim())
          .filter((name) => name.length >= 2 && !normalizedQuery.includes(name.toLowerCase()));
        for (const name of names) {
          const probe = `${String(community.title || '').trim()} ${name}`.trim();
          if (probe && !probes.includes(probe)) probes.push(probe);
          if (probes.length >= maxProbes) break;
        }
        if (probes.length >= maxProbes) break;
      }
      if (!probes.length) probes.push(...seedEntities.slice(0, maxProbes));
      return { probes: probes.slice(0, maxProbes), communityIds, seedEntities };
    } catch (err) {
      this.logger.debug(`DRIFT planning unavailable: ${err instanceof Error ? err.message : String(err)}`);
      recordFailopen('graph');
      return empty;
    }
  }
}

function entityMapSize(map: Map<any, any>): number {
  return map.size;
}
