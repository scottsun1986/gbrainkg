import { Injectable, Logger } from '@nestjs/common';
import { getPrismaClient } from '../prisma';

export type EntityType = 'concept' | 'organization' | 'system' | 'policy' | 'document';
export type RelationType = 'contains' | 'references' | 'regulates' | 'depends_on' | 'relates_to' | 'mentions';

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

function cleanLabel(value: string): string {
  return value.replace(/^#+\s*/, '').replace(/\.(pdf|docx?|pptx?|xlsx?|md|txt|csv)$/i, '').trim();
}

@Injectable()
export class GraphRagService {
  private readonly logger = new Logger(GraphRagService.name);
  private prisma = getPrismaClient();

  /**
   * Determine entity semantic category by naming heuristics and patterns.
   */
  classifyEntityType(name: string): EntityType {
    const trimmed = name.trim();
    if (/(?:公司|集团|部门|中心|小组|委员会|团队|部|处|室)$/u.test(trimmed)) {
      return 'organization';
    }
    if (/(?:系统|平台|服务|引擎|数据库|架构|网关|模块|中间件)$/u.test(trimmed)) {
      return 'system';
    }
    if (/^[《「].+[》」]$/u.test(trimmed) || /(?:规范|制度|标准|规程|办法|指南|方案|条例|守则|准则)$/u.test(trimmed)) {
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

      // 3. Organization and system entities
      for (const match of content.matchAll(/([\p{L}\p{N}]{2,32}(?:公司|中心|部门|医院|集团|平台|系统|项目|规范|制度|管理|评估|安全|组织|小组))/gu)) {
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
    {"source": "源实体名", "target": "目标实体名", "type": "contains|references|regulates|depends_on|relates_to|mentions", "evidence": "原文证据"}
  ]
}

要求：
1. 实体名必须是文本中明确出现的名词或专有名词
2. 每条关系必须附带 evidence（原文中的依据）
3. type 必须是指定的枚举值之一
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
      const validTypes: EntityType[] = ['concept', 'organization', 'system', 'policy', 'document'];
      const validRelTypes: RelationType[] = ['contains', 'references', 'regulates', 'depends_on', 'relates_to', 'mentions'];

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
      if (!entityMap.has(e.name)) {
        entityMap.set(e.name, e);
      } else if (e.description && !entityMap.get(e.name)!.description) {
        // LLM provides better descriptions
        entityMap.set(e.name, { ...entityMap.get(e.name)!, description: e.description });
      }
    }

    // Deduplicate relations
    const relKey = (r: ExtractedRelation) => `${r.sourceName}|${r.targetName}|${r.relationType}`;
    const relMap = new Map<string, ExtractedRelation>();
    for (const r of regexResult.relations) {
      relMap.set(relKey(r), r);
    }
    for (const r of allLlmRelations) {
      const key = relKey(r);
      if (!relMap.has(key)) {
        relMap.set(key, r);
      }
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

    // 1. Upsert entities
    for (const e of entities) {
      const record = await (this.prisma as any).graphEntity.upsert({
        where: {
          kbId_name: {
            kbId,
            name: e.name,
          },
        },
        create: {
          kbId,
          name: e.name,
          type: e.type,
          description: e.description || null,
          aliases: [],
          properties: e.sourceDocId ? { docIds: [e.sourceDocId] } : {},
        },
        update: {
          type: e.type,
          ...(e.description ? { description: e.description } : {}),
        },
      });
      entityNameToId.set(e.name, record.id);
    }

    // 2. Upsert relations
    let savedRelations = 0;
    for (const r of relations) {
      const sourceId = entityNameToId.get(r.sourceName);
      const targetId = entityNameToId.get(r.targetName);
      if (!sourceId || !targetId || sourceId === targetId) continue;

      try {
        const whereClause = {
          sourceId_targetId_relationType: {
            sourceId,
            targetId,
            relationType: r.relationType,
          },
        };
        const existing = await (this.prisma as any).graphRelation.findUnique({
          where: whereClause,
        });

        const newProv = r.snippet
          ? {
              documentId: r.provenanceDocId,
              documentVersion: r.documentVersion || 1,
              chunkId: r.chunkId,
              snippet: r.snippet,
            }
          : null;

        if (existing) {
          let updatedProv = existing.provenance;
          if (newProv && Array.isArray(updatedProv)) {
            const exists = updatedProv.some(
              (p: any) =>
                p.documentId === newProv.documentId &&
                p.documentVersion === newProv.documentVersion &&
                p.chunkId === newProv.chunkId,
            );
            if (!exists) {
              updatedProv = [...updatedProv, newProv];
            }
          } else if (newProv) {
            updatedProv = [newProv];
          }

          await (this.prisma as any).graphRelation.update({
            where: whereClause,
            data: {
              weight: { increment: 0.5 },
              provenance: updatedProv,
            },
          });
        } else {
          await (this.prisma as any).graphRelation.create({
            data: {
              kbId,
              sourceId,
              targetId,
              relationType: r.relationType,
              weight: r.weight ?? 1.0,
              description: r.description || null,
              provenance: newProv ? [newProv] : [],
            },
          });
        }
        savedRelations++;
      } catch (err: any) {
        // Skip duplicate or constraint races
      }
    }

    return {
      entityCount: entityMapSize(entityNameToId),
      relationCount: savedRelations,
    };
  }

  /**
   * Builds communities and global summaries for a Knowledge Base (WeKnora GraphRAG Global Search).
   */
  async buildCommunitiesForKb(kbId: string): Promise<number> {
    const entities = await (this.prisma as any).graphEntity.findMany({
      where: { kbId },
      include: {
        outgoingRelations: {
          include: { target: true },
        },
      },
    });

    if (!entities.length) return 0;

    // Simple BFS / Connected Components clustering for community detection
    const visited = new Set<string>();
    const communities: Array<typeof entities> = [];

    const entityById = new Map<string, any>(entities.map((e: any) => [e.id, e]));

    for (const entity of entities) {
      if (visited.has(entity.id)) continue;
      const currentCluster: typeof entities = [];
      const queue: string[] = [entity.id];
      visited.add(entity.id);

      while (queue.length > 0 && currentCluster.length < 30) {
        const currId = queue.shift()!;
        const curr = entityById.get(currId);
        if (!curr) continue;
        currentCluster.push(curr);

        for (const rel of curr.outgoingRelations || []) {
          if (!visited.has(rel.targetId)) {
            visited.add(rel.targetId);
            queue.push(rel.targetId);
          }
        }
      }
      if (currentCluster.length >= 2) {
        communities.push(currentCluster);
      }
    }

    // Clean old communities for this KB
    await (this.prisma as any).graphCommunity.deleteMany({ where: { kbId } });

    let created = 0;
    for (let i = 0; i < communities.length; i++) {
      const cluster = communities[i];
      const titles = cluster.map((e: any) => e.name);
      const types = [...new Set(cluster.map((e: any) => e.type))];
      const mainTitle = titles.slice(0, 3).join(' / ') + ` (社区 ${i + 1})`;

      const summary = `本知识社区涵盖了以下核心实体：${titles.slice(0, 10).join('、')}。涵盖领域类别：${types.join('、')}。涉及制度引用与系统实体间的相互协作、归属与管理关系。`;

      await (this.prisma as any).graphCommunity.create({
        data: {
          kbId,
          title: mainTitle,
          level: 0,
          summary,
          entityIds: cluster.map((e: any) => e.id),
          findings: [
            `核心实体：${titles.slice(0, 5).join(', ')}`,
            `实体总数：${cluster.length} 个`,
          ],
        },
      });
      created++;
    }

    this.logger.log(`Built ${created} GraphRAG communities for KB ${kbId}`);
    return created;
  }

  /**
   * GraphRAG Local Search: matches question entities, expands 1-hop / 2-hop relations.
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
    const terms = query
      .split(/[\s,，、。！？?；;:：()（）《》「」“”"']+/u)
      .filter((t) => t.length >= 2);

    if (!terms.length) {
      return { entities: [], relations: [], formattedContext: '' };
    }

    const isDocCatalogQuery = /(哪些.*(文档|知识|制度|资料)|(文档|知识|制度|资料).*哪些|(文档|制度).*(列表|清单|目录|全景)|(所有|全部).*(文档|制度))/u.test(query);
    const orConditions: any[] = terms.map((term) => ({ name: { contains: term, mode: 'insensitive' } }));
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

    const relationsList: Array<{
      source: string;
      target: string;
      relationType: string;
      weight: number;
      snippet?: string;
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

    for (const entity of entities) {
      for (const rel of entity.outgoingRelations || []) {
        relationsList.push({
          source: entity.name,
          target: rel.target.name,
          relationType: rel.relationType,
          weight: rel.weight,
          snippet: (rel.provenance as any)?.[0]?.snippet,
        });
        const snippetInfo = (rel.provenance as any)?.[0]?.snippet ? ` (依据: "${(rel.provenance as any)[0].snippet}")` : '';
        contextLines.push(`- [${entity.name}] (${entity.type}) --[${rel.relationType}]--> [${rel.target.name}] (${rel.target.type})${snippetInfo}`);
      }
      for (const rel of entity.incomingRelations || []) {
        relationsList.push({
          source: rel.source.name,
          target: entity.name,
          relationType: rel.relationType,
          weight: rel.weight,
          snippet: (rel.provenance as any)?.[0]?.snippet,
        });
        const snippetInfo = (rel.provenance as any)?.[0]?.snippet ? ` (依据: "${(rel.provenance as any)[0].snippet}")` : '';
        contextLines.push(`- [${rel.source.name}] (${rel.source.type}) --[${rel.relationType}]--> [${entity.name}] (${entity.type})${snippetInfo}`);
      }
    }

    return {
      entities: entities.map((e: any) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
      })),
      relations: relationsList,
      formattedContext: contextLines.length > 1 ? contextLines.slice(0, 15).join('\n') : '',
    };
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
}

function entityMapSize(map: Map<any, any>): number {
  return map.size;
}
