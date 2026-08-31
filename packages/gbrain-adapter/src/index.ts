declare const require: any;
declare const process: any;

const { mkdir, writeFile, access, rename, unlink, readdir } = require('node:fs').promises;
const { join, dirname } = require('node:path');
const { spawn } = require('node:child_process');

export interface BrainEvidence {
  text: string;
  sourceFile?: string;
  kbId?: string;
  kbName?: string;
  kbType?: string;
  topic?: string;
  slug?: string;
}

export interface BrainQueryResult {
  topics: string[];
  answer: string;
  citations: Array<{ topic: string; kbId?: string; docId?: string; docTitle?: string; snippet: string; context?: string; score?: number }>;
  reranked?: boolean;
}

export interface BrainQueryOptions {
  breadth?: boolean;
}

export interface BrainMaintenanceResult {
  status?: string;
  schema_version?: string;
  phases?: Array<{ phase?: string; status?: string; summary?: string; reason?: string }>;
  [key: string]: unknown;
}

function safePart(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user';
}

function sourceIdForUser(userId: string): string {
  return `llmwiki-${safePart(userId.replace(/-/g, '').slice(0, 16))}`.slice(0, 32);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function canonicalPage(slug: string, items: BrainEvidence[]): string {
  const first = items[0];
  const title = (first.topic || first.sourceFile || slug).replace(/\.[^.]+$/, '').trim();
  const body = items.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
  const aliases = [...new Set([first.sourceFile, first.topic].filter((value): value is string => Boolean(value && value !== title)))];
  const documentId = slug.startsWith('docs/') ? slug.slice('docs/'.length) : slug;
  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    'type: source',
    `aliases: ${JSON.stringify(aliases)}`,
    `source_uri: ${yamlString(`llmwiki://knowledge-bases/${first.kbId || 'unknown'}/documents/${documentId}`)}`,
    `kb_id: ${yamlString(first.kbId || '')}`,
    `kb_name: ${yamlString(first.kbName || '')}`,
    `kb_type: ${yamlString(first.kbType || '')}`,
    `document_id: ${yamlString(documentId)}`,
    '---',
  ].join('\n');
  const heading = body.startsWith(`# ${title}`) ? '' : `# ${title}\n\n`;
  return `${frontmatter}\n\n${heading}${body}`.trim();
}

/** Production bridge to the official garrytan/gbrain CLI. */
export class BrainRepoAdapter {
  private readonly gbrainBin = process.env.GBRAIN_BIN || '/home/scottsun/.bun/bin/gbrain';
  private readonly gbrainHome = process.env.GBRAIN_HOME || '/home/scottsun/.config/gbrain';
  private readonly sourceRoot: string;
  private searchConfigSignature = '';
  private searchConfigPromise: Promise<void> | null = null;
  private queryCache = new Map<string, { expiresAt: number; result: BrainQueryResult }>();

  constructor(basePath: string) {
    this.sourceRoot = join(basePath, 'gbrain-sources');
  }

  private invalidateCache(sourceId?: string): void {
    if (!sourceId) {
      this.queryCache.clear();
      return;
    }
    for (const key of this.queryCache.keys()) {
      if (key.startsWith(`${sourceId}:`)) this.queryCache.delete(key);
    }
  }

  private sourceId(repoPath: string): string {
    const match = /^gbrain:\/\/source\/(.+)$/.exec(repoPath);
    if (!match) throw new Error(`Invalid GBrain source reference: ${repoPath}`);
    return match[1];
  }

  private async run(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
    const env: Record<string, string> = {
      ...process.env,
      GBRAIN_HOME: this.gbrainHome,
      PATH: `/home/scottsun/.bun/bin:${process.env.PATH || ''}`,
    };
    // Prisma accepts the `schema` query parameter, but the GBrain CLI treats
    // it as a PostgreSQL runtime setting and fails with “unrecognized
    // configuration parameter schema”. Keep the application URL untouched;
    // only normalize the child-process environment used by GBrain.
    const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (databaseUrl) {
      env.DATABASE_URL = databaseUrl
        .replace(/([?&])schema=[^&]*&?/i, "$1")
        .replace(/[?&]$/, "");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.gbrainBin, args, { env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const timeoutMs = Math.max(30_000, Number(process.env.GBRAIN_COMMAND_TIMEOUT_MS || 180_000));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
        setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5_000);
      }, timeoutMs);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      child.stdout.on('data', (chunk: any) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: any) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error: Error) => finish(() => reject(error)));
      child.on('close', (code: number) => {
        if (code === 0) finish(() => resolve({ stdout, stderr }));
        else finish(() => reject(new Error(`gbrain ${args.join(' ')} failed (${code} or timeout): ${stderr || stdout}`)));
      });
      child.stdin.end(input);
    });
  }

  private async runGit(args: string[], cwd: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code: number) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`)));
    }).catch((err) => {
      if (args[0] === 'commit') return;
      throw err;
    });
  }

  private async ensureSearchConfig(): Promise<void> {
    const embeddingModel = process.env.GBRAIN_EMBEDDING_MODEL || '';
    const embeddingDimensions = process.env.GBRAIN_EMBEDDING_DIMENSIONS || '';
    const embeddingBaseUrl = process.env.OPENAI_BASE_URL || '';
    const reranker = process.env.GBRAIN_RERANK_MODEL || '';
    const rerankerBaseUrl = process.env.LLAMA_SERVER_RERANKER_BASE_URL || '';
    const chatModel = process.env.GBRAIN_CHAT_MODEL || '';
    const expansionModel = process.env.GBRAIN_EXPANSION_MODEL || '';
    const deepseekBaseUrl = process.env.GBRAIN_DEEPSEEK_BASE_URL || '';
    const signature = [embeddingModel, embeddingDimensions, embeddingBaseUrl, reranker, rerankerBaseUrl, chatModel, expansionModel, deepseekBaseUrl].join('|');
    if (this.searchConfigSignature === signature) return;
    if (this.searchConfigPromise) await this.searchConfigPromise;
    if (this.searchConfigSignature === signature) return;

    this.searchConfigPromise = (async () => {
      await this.run(['config', 'set', 'search.mode', 'balanced']);
      // Enterprise questions are often phrased differently from the source.
      // Let GBrain expand queries generically instead of adding application-level
      // rules for article numbers, filenames, or individual question patterns.
      await this.run(['config', 'set', 'search.expansion', 'true']);
      // GBrain intentionally rejects embedding model/dimension writes through
      // the DB config plane because they size the vector schema. The adapter
      // supplies both as child-process environment values from platform DB;
      // the existing 1024-wide schema already matches BAAI/bge-m3.
      if (embeddingBaseUrl) await this.run(['config', 'set', 'provider_base_urls.openai', embeddingBaseUrl]);
      if (reranker) {
        await this.run(['config', 'set', 'search.reranker.model', reranker]);
        await this.run(['config', 'set', 'search.reranker.enabled', 'true']);
      }
      if (rerankerBaseUrl) await this.run(['config', 'set', 'provider_base_urls.llama-server-reranker', rerankerBaseUrl]);
      if (chatModel) await this.run(['config', 'set', 'chat_model', chatModel]);
      if (expansionModel) await this.run(['config', 'set', 'expansion_model', expansionModel]);
      if (deepseekBaseUrl) await this.run(['config', 'set', 'provider_base_urls.deepseek', deepseekBaseUrl]);
      this.searchConfigSignature = signature;
    })();
    try { await this.searchConfigPromise; } finally { this.searchConfigPromise = null; }
  }

  private async ensureSource(sourceId: string): Promise<string> {
    const sourcePath = join(this.sourceRoot, sourceId);
    await mkdir(sourcePath, { recursive: true });
    try { await access(join(sourcePath, '.git')); } catch {
      await writeFile(join(sourcePath, '.gbrain-source'), `${sourceId}\n`, 'utf8');
      await this.runGit(['init', '-q'], sourcePath).catch(() => undefined);
      await this.runGit(['config', 'user.email', 'llmwiki@local'], sourcePath).catch(() => undefined);
      await this.runGit(['config', 'user.name', 'LLMWiki'], sourcePath).catch(() => undefined);
      await this.runGit(['add', '.gbrain-source'], sourcePath).catch(() => undefined);
      await this.runGit(['commit', '-qm', 'initialize source', '--allow-empty'], sourcePath).catch(() => undefined);
    }
    try {
      await this.run(['sources', 'add', sourceId, '--path', sourcePath, '--force']);
    } catch (error: unknown) {
      const message = String(error).toLowerCase();
      if (!message.includes('already exists') && !message.includes('already registered')) throw error;
    }
    return sourcePath;
  }

  async initializeRepo(userId: string): Promise<string> {
    const sourceId = sourceIdForUser(userId);
    await this.ensureSource(sourceId);
    return `gbrain://source/${sourceId}`;
  }

  /** Initialize/register a named source without creating a per-user source. */
  async initializeSource(sourceId: string): Promise<string> {
    await this.ensureSource(sourceId);
    return `gbrain://source/${sourceId}`;
  }

  private pagePath(sourcePath: string, slug: string): string {
    const parts = slug.split('/').filter(Boolean).map((part) => part.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, ''));
    if (!parts.length) throw new Error('A non-empty GBrain page slug is required.');
    if (parts.some((part) => !part)) throw new Error(`Invalid GBrain page slug: ${slug}`);
    return join(sourcePath, ...parts) + '.md';
  }

  /** Whether the source repository already contains canonical Markdown pages. */
  async isSourceMaterialized(repoPath: string): Promise<boolean> {
    const sourcePath = await this.ensureSource(this.sourceId(repoPath));
    const walk = async (dir: string): Promise<boolean> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory() && await walk(path)) return true;
        if (entry.isFile() && entry.name.endsWith('.md')) return true;
      }
      return false;
    };
    return walk(sourcePath);
  }

  async ingest(repoPath: string, evidence: BrainEvidence[]): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    const sourcePath = await this.ensureSource(sourceId);
    const grouped = new Map<string, BrainEvidence[]>();
    for (const item of evidence) {
      const slug = item.slug || `docs/${safePart(item.topic || 'document')}`;
      grouped.set(slug, [...(grouped.get(slug) || []), item]);
    }
    for (const [slug, items] of grouped) {
      const content = canonicalPage(slug, items);
      if (content) {
        // The source repository is the durable system of record recommended by
        // GBrain. Write canonical Markdown first, then let `sync` perform its
        // own incremental chunking, embedding and graph projection.
        const path = this.pagePath(sourcePath, slug);
        await mkdir(dirname(path), { recursive: true });
        const tempPath = `${path}.tmp`;
        await writeFile(tempPath, `${content}\n`, 'utf8');
        await rename(tempPath, path);
      }
    }
    if (!grouped.size) return;
    await this.runGit(['add', '-A'], sourcePath);
    await this.runGit(['commit', '-qm', 'sync knowledge documents'], sourcePath);
    await this.run(['sync', '--source', sourceId]);
    this.invalidateCache(sourceId);
  }

  async replace(repoPath: string, evidence: BrainEvidence[]): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    await this.ensureSource(sourceId);
    await this.run(['sources', 'remove', sourceId, '--confirm-destructive']).catch(() => undefined);
    await this.ensureSource(sourceId);
    await this.ingest(repoPath, evidence);
    this.invalidateCache(sourceId);
  }

  async delete(repoPath: string, slug: string): Promise<void> {
    await this.deleteMany(repoPath, [slug]);
  }

  async deleteMany(repoPath: string, slugs: string[]): Promise<void> {
    if (!slugs.length) return;
    const sourceId = this.sourceId(repoPath);
    const sourcePath = await this.ensureSource(sourceId);
    for (const slug of slugs) {
      await unlink(this.pagePath(sourcePath, slug)).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await this.runGit(['add', '-A'], sourcePath);
    await this.runGit(['commit', '-qm', 'remove knowledge document'], sourcePath);
    await this.run(['sync', '--source', sourceId]);
    this.invalidateCache(sourceId);
  }

  /** Run GBrain's own deterministic maintenance phases for one named source. */
  async maintain(repoPath: string): Promise<BrainMaintenanceResult | null> {
    const sourceId = this.sourceId(repoPath);
    await this.ensureSource(sourceId);
    await this.ensureSearchConfig();
    const { stdout } = await this.run(['dream', '--source', sourceId, '--json']);
    // Dream may normalize frontmatter (for example, adding `created`) while
    // maintaining the derived index. Keep the source repository clean and
    // auditable so the next sync does not report those legitimate writes as
    // uncommitted-work warnings.
    const sourcePath = join(this.sourceRoot, sourceId);
    await this.runGit(['add', '-A'], sourcePath);
    await this.runGit(['commit', '-qm', 'gbrain dream maintenance'], sourcePath);
    this.invalidateCache(sourceId);
    // The CLI may print human-readable phase lines before its JSON document.
    // Keep the machine-readable result so the API can expose real phase
    // outcomes instead of treating a zero exit code as the whole story.
    const trimmed = stdout.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.search(/\{\s*"schema_version"/);
      if (start < 0) return null;
      try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
    }
  }

  async query(repoPath: string, question: string, options: BrainQueryOptions = {}): Promise<BrainQueryResult> {
    const sourceId = this.sourceId(repoPath);
    const cacheKey = `${sourceId}:${options.breadth ? 'broad' : 'focused'}:${question.trim()}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    await this.ensureSearchConfig();
    // Use GBrain's official balanced retrieval stack as designed: query
    // expansion + vector/BM25/RRF + graph signals + reranker + autocut.
    // No application-side keyword rules or language-specific retries.
    const args = [
      'query', question,
      '--source-id', sourceId,
      '--mode', 'balanced',
      '--limit', options.breadth ? '50' : '30',
      '--detail', 'high',
      '--snippet-chars', '1800',
      '--json',
    ];
    // GBrain recommends disabling autocut for broad enumeration and landscape
    // questions so the caller can judge a wider candidate set.
    if (options.breadth) args.splice(args.length - 1, 0, '--autocut', 'false');
    else args.splice(args.length - 1, 0, '--adaptive-return', 'true');
    const { stdout } = await this.run(args);
    let rawRows: Array<{ slug: string; title: string; chunk_text?: string; source_id?: string; rerank_score?: number; score?: number }> = [];
    try { rawRows = JSON.parse(stdout || '[]'); } catch { rawRows = []; }

    // GBrain can return multiple high-scoring chunks from one page. Collapse
    // them into one citation while retaining all distinct evidence snippets.
    const bySlug = new Map<string, { slug: string; title: string; chunk_text: string; source_id?: string; rerank_score?: number; score?: number }>();
    for (const row of rawRows) {
      if (!row.slug) continue;
      const previous = bySlug.get(row.slug);
      const snippet = String(row.chunk_text || '').trim();
      if (!previous) bySlug.set(row.slug, { ...row, chunk_text: snippet });
      else if (snippet && !previous.chunk_text.includes(snippet)) previous.chunk_text = `${previous.chunk_text}\n\n${snippet}`.trim();
    }
    const rows = [...bySlug.values()];

    // Generic parent-document retrieval: hydrate the top matched pages within
    // a fixed context budget. This gives the answer model complete policy
    // context for details, totals and cross-section questions without trying
    // to classify every possible wording in application code.
    const pageBudget = Math.max(8_000, Number(process.env.GBRAIN_CONTEXT_MAX_CHARS || (options.breadth ? 120_000 : 80_000)));
    const maxParents = Math.max(1, Number(process.env.GBRAIN_CONTEXT_MAX_PARENTS || (options.breadth ? 5 : 3)));
    let remaining = pageBudget;
    const pageContext = new Map<string, string>();
    for (const row of rows.slice(0, maxParents)) {
      try {
        const page = await this.getPage(repoPath, row.slug);
        if (page && page.length <= remaining) {
          pageContext.set(row.slug, page);
          remaining -= page.length;
        }
      } catch {
        // A stale page pointer degrades to the retrieved GBrain chunk.
      }
    }
    const citations = rows.map((row) => ({
      topic: row.title || row.slug,
      docId: /^docs\/[^/]+$/.test(row.slug) ? row.slug.slice('docs/'.length) : undefined,
      docTitle: row.title,
      snippet: row.chunk_text || '',
      context: pageContext.get(row.slug) || row.chunk_text || '',
      score: typeof row.rerank_score === 'number' ? row.rerank_score : row.score,
    }));
    const result: BrainQueryResult = {
      topics: citations.map((citation) => citation.topic),
      answer: citations.map((citation) => citation.context).filter(Boolean).join('\n\n'),
      citations,
      reranked: rawRows.some((row) => typeof row.rerank_score === 'number'),
    };
    this.queryCache.set(cacheKey, { expiresAt: Date.now() + 30_000, result });
    if (this.queryCache.size > 200) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest) this.queryCache.delete(oldest);
    }
    return result;
  }

  private async getPage(repoPath: string, slug: string): Promise<string> {
    const sourceId = this.sourceId(repoPath);
    const { stdout } = await this.run(['get', slug, '--include-content', '--source-id', sourceId, '--json']);
    try {
      const payload = JSON.parse(stdout || '{}');
      return String(payload.content || payload.compiled_truth || payload.body || '');
    } catch {
      return stdout.trim();
    }
  }

  /** Query the shared source plus the user's private permission-group sources. */
  async queryMany(repoPaths: string[], question: string, options: BrainQueryOptions = {}): Promise<BrainQueryResult> {
    const results = await Promise.all(repoPaths.map((repoPath) => this.query(repoPath, question, options)));
    const citations = results.flatMap((result) => result.citations || []);
    const unique = new Map<string, BrainQueryResult['citations'][number]>();
    for (const citation of citations) {
      const key = `${citation.kbId || ''}:${citation.docId || citation.topic}`;
      if (!unique.has(key)) unique.set(key, citation);
    }
    // Every source is reranked with the same configured cross-encoder. Preserve
    // those comparable scores when federating instead of biasing toward the
    // source that happened to be queried first.
    const merged = [...unique.values()]
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -Infinity) - (typeof a.score === 'number' ? a.score : -Infinity))
      .slice(0, options.breadth ? 40 : 8);
    return {
      topics: merged.map((citation) => citation.topic),
      answer: merged.map((citation) => citation.context || citation.snippet).filter(Boolean).join('\n\n'),
      citations: merged,
      reranked: results.every((result) => result.reranked),
    };
  }
}
