declare const require: any;
declare const process: any;

const { mkdir, writeFile, access, rename, unlink, readdir } = require('node:fs').promises;
const { join, dirname, resolve } = require('node:path');
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
  citations: Array<{
    topic: string;
    slug?: string;
    sourceKey?: string;
    kbId?: string;
    docId?: string;
    docTitle?: string;
    section?: string;
    snippet: string;
    context?: string;
    score?: number;
    evidence?: string;
  }>;
  reranked?: boolean;
  retrievalGate?: { removed: number; scoreFloor: number; topScore: number };
}

export interface BrainQueryOptions {
  breadth?: boolean;
  operation?: 'search' | 'query';
}

export interface BrainMaintenanceResult {
  status?: string;
  schema_version?: string;
  phases?: Array<{ phase?: string; status?: string; summary?: string; reason?: string }>;
  [key: string]: unknown;
}

export interface BrainSynthesisResult {
  answer?: string;
  sources?: unknown;
  gaps?: unknown;
  warnings?: unknown;
  synthesis_status?: string;
  pages_gathered?: number;
  takes_gathered?: number;
  cost?: unknown;
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
  const rawBody = items.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
  // Converters often emit the document title as a body heading while the
  // adapter also adds the canonical title. Keep one deterministic heading so
  // title-only duplicates cannot consume retrieval budget or outrank content.
  const body = rawBody
    .split(/\r?\n/)
    .filter((line) => {
      const comparable = line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*\*{1,2}/, '')
        .replace(/\*{1,2}\s*$/, '')
        .trim();
      return comparable !== title;
    })
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
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

type Passage = { heading?: string; content: string; score: number };

function structuralPassages(markdown: string): Array<{ heading?: string; content: string }> {
  const body = markdown.replace(/^---\s*[\s\S]*?---\s*/m, '').trim();
  const lines = body.split(/\r?\n/);
  const sections: Array<{ heading?: string; content: string }> = [];
  let heading = '';
  let buffer: string[] = [];
  // This recognizes document structure, not a user-question-specific pattern:
  // Markdown headings, Chinese chapter/article markers and enumerated clauses.
  const headingBoundary = /^#{1,6}\s+.+$/u;
  const articleBoundary = /^第\s*[\d一二三四五六七八九十百千万〇零两]+\s*[章节条款项].*$/u;
  const numberedBoundary = /^[（(]?[\d一二三四五六七八九十百千万]+[）).、]\s*.+$/u;
  let insideArticle = false;
  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) sections.push({ heading: heading || undefined, content });
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const comparable = trimmed.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '').trim();
    const isHeading = headingBoundary.test(trimmed);
    const isArticle = articleBoundary.test(comparable);
    const isNumbered = numberedBoundary.test(trimmed);
    // Numbered paragraphs inside an article are subclauses, not independent
    // retrieval passages. This keeps the complete article available to the
    // answer model while still splitting numbered lists outside articles.
    if (isHeading || isArticle || (isNumbered && !insideArticle)) {
      flush();
      heading = line.trim();
      buffer = [line];
      insideArticle = isArticle;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ content: body }];
}

function lexicalFeatures(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  const features = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || []) {
    features.add(word);
    if (/^[\u4e00-\u9fff]+$/u.test(word)) {
      for (let size = 2; size <= Math.min(4, word.length); size += 1) {
        for (let i = 0; i + size <= word.length; i += 1) features.add(word.slice(i, i + size));
      }
    }
  }
  return features;
}

/**
 * Second-stage, document-local passage ranking. It runs after GBrain has
 * retrieved a candidate page and works from generic document structure so it
 * covers articles, clauses, tables and headings without special-casing a
 * particular user wording such as "第 N 条".
 */
function localizePassage(question: string, page: string, fallback: string): Passage {
  const queryFeatures = lexicalFeatures(question);
  const sections = structuralPassages(page);
  const ranked = sections.map((section) => {
    const text = `${section.heading || ''}\n${section.content}`;
    const features = lexicalFeatures(text);
    let matched = 0;
    for (const feature of queryFeatures) if (features.has(feature)) matched += 1;
    const headingFeatures = lexicalFeatures(section.heading || '');
    let headingMatched = 0;
    for (const feature of queryFeatures) if (headingFeatures.has(feature)) headingMatched += 1;
    const score = (matched / Math.max(1, queryFeatures.size)) + (headingMatched / Math.max(1, queryFeatures.size));
    return { heading: section.heading, content: section.content, score };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score <= 0) return { content: fallback || page, score: 0 };
  const index = sections.findIndex((section) => section.content === best.content);
  // Neighboring context is useful only when it independently supports the
  // question. Blindly appending both neighbors lets unrelated policy text
  // enter a precise answer. This is a generic evidence gate, not a clause
  // number special case.
  const adjacent = [sections[index - 1], sections[index + 1]]
    .map((section) => ({ section, rank: ranked.find((item) => item.content === section?.content) }))
    .filter((item) => item.section && item.rank && item.rank.score >= Math.max(0.05, best.score * 0.45))
    .map((item) => item.section!.content)
    .join('\n\n');
  const content = [best.content, adjacent].filter(Boolean).join('\n\n').slice(0, 18_000);
  return { heading: best.heading, content, score: best.score };
}

/** Production bridge to the official garrytan/gbrain CLI. */
export class BrainRepoAdapter {
  private readonly gbrainBin = process.env.GBRAIN_BIN || '/home/scottsun/.bun/bin/gbrain';
  private readonly gbrainHome = process.env.GBRAIN_HOME || '/home/scottsun/.config/gbrain';
  private readonly sourceRoot: string;
  private searchConfigSignature = '';
  private searchConfigPromise: Promise<void> | null = null;
  private queryCache = new Map<string, { expiresAt: number; result: BrainQueryResult }>();
  private sourceSyncLocks = new Map<string, Promise<void>>();

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
      GBRAIN_POOL_SIZE: process.env.GBRAIN_POOL_SIZE || '2',
      PATH: `/home/scottsun/.bun/bin:${process.env.PATH || ''}`,
    };
    // Prisma accepts the `schema` query parameter, but the GBrain CLI treats
    // it as a PostgreSQL runtime setting and fails with “unrecognized
    // configuration parameter schema”. Keep the application URL untouched;
    // only normalize the child-process environment used by GBrain.
    const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (databaseUrl) {
      const normalizedDatabaseUrl = databaseUrl
        .replace(/([?&])schema=[^&]*&?/i, "$1")
        .replace(/[?&]$/, "");
      // GBrain prefers GBRAIN_DATABASE_URL over DATABASE_URL. Normalize both
      // planes so a Prisma-only `schema=public` parameter cannot make the CLI
      // use a different connection string from the one we just validated.
      env.DATABASE_URL = normalizedDatabaseUrl;
      env.GBRAIN_DATABASE_URL = normalizedDatabaseUrl;
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

  private parseJsonObject(raw: string): Record<string, any> {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // GBrain may emit a cost-gate envelope followed by the command result.
        // Fall through and parse the last complete JSON line below.
      }
    }
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const start = lines[index].indexOf('{');
      if (start < 0) continue;
      try {
        const parsed = JSON.parse(lines[index].slice(start));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Keep looking: human output or an earlier JSON envelope may precede
        // the final machine-readable result.
      }
    }
    throw new Error(`Invalid GBrain JSON response: ${trimmed.slice(0, 300)}`);
  }

  private async sourcePageCount(sourceId: string): Promise<number> {
    const row = await this.registeredSource(sourceId);
    if (!row) throw new Error(`GBrain source ${sourceId} is not present in the source status report.`);
    const count = Number(row.total_pages ?? row.page_count);
    if (!Number.isFinite(count)) throw new Error(`GBrain source ${sourceId} returned no page count.`);
    return count;
  }

  private async registeredSource(sourceId: string): Promise<Record<string, any> | null> {
    const { stdout } = await this.run(['sources', 'status', '--json']);
    const payload = this.parseJsonObject(stdout);
    return (Array.isArray(payload.sources) ? payload.sources : []).find(
      (item: any) => item?.source_id === sourceId || item?.id === sourceId,
    ) || null;
  }

  private async assertEmbeddingPlane(): Promise<void> {
    const expected = Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS || '');
    if (!Number.isInteger(expected) || expected <= 0) return;
    const { stdout } = await this.run(['migrate', 'embeddings', '--status']);
    const match = stdout.match(/Column:\s+content_chunks\.embedding\s+(\d+)d/i);
    if (!match) throw new Error('Unable to verify GBrain embedding dimensions from `gbrain migrate embeddings --status`.');
    const actual = Number(match[1]);
    if (actual !== expected) {
      throw new Error(
        `GBrain embedding plane mismatch: runtime is ${expected}d but content_chunks.embedding is ${actual}d. ` +
        `Run the official migration to the configured embedding model before indexing or querying.`,
      );
    }
  }

  private async syncSource(sourceId: string, expectedAddedPages = 0): Promise<void> {
    const previous = this.sourceSyncLocks.get(sourceId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const chain = previous.catch(() => undefined).then(() => current);
    this.sourceSyncLocks.set(sourceId, chain);
    await previous.catch(() => undefined);
    try {
      const { stdout } = await this.run(['sync', '--source', sourceId, '--json']);
      const payload = this.parseJsonObject(stdout);
      const sourceRows = Array.isArray(payload.sources) ? payload.sources : [];
      const sourceError = sourceRows.find((item: any) => item?.status === 'error');
      const syncStatus = String(payload.sync_status ?? payload.status ?? sourceRows[0]?.sync_status ?? '');
      const errorCount = Number(payload.error_count ?? sourceRows[0]?.error_count ?? 0);
      if (sourceError || errorCount > 0 || ['error', 'partial', 'blocked_by_failures'].includes(syncStatus)) {
        throw new Error(`GBrain source sync failed for ${sourceId}: ${JSON.stringify(sourceError || payload)}`);
      }
      if (expectedAddedPages > 0) {
        const indexedPages = await this.sourcePageCount(sourceId);
        if (indexedPages < expectedAddedPages) {
          throw new Error(
            `GBrain source sync incomplete for ${sourceId}: expected at least ${expectedAddedPages} indexed page(s), found ${indexedPages}.`,
          );
        }
      }
    } finally {
      release();
      if (this.sourceSyncLocks.get(sourceId) === chain) this.sourceSyncLocks.delete(sourceId);
    }
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

  private async runGitOutput(args: string[], cwd: string): Promise<string> {
    return new Promise<string>((resolveOutput, reject) => {
      const child = spawn('git', args, { cwd, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: any) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: any) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code: number) => code === 0
        ? resolveOutput(stdout.trim())
        : reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`)));
    });
  }

  private configuredRemote(sourceId: string): string | null {
    const template = String(process.env.GBRAIN_SOURCE_REMOTE_URL_TEMPLATE || '').trim();
    if (!template) return null;
    if (!template.includes('{source}')) {
      throw new Error('GBRAIN_SOURCE_REMOTE_URL_TEMPLATE must contain the {source} placeholder.');
    }
    return template.replaceAll('{source}', sourceId);
  }

  private async ensureSourceRemote(sourceId: string, sourcePath: string): Promise<void> {
    const remote = this.configuredRemote(sourceId);
    if (!remote) return;
    const existing = await this.runGitOutput(['remote', 'get-url', 'origin'], sourcePath).catch(() => '');
    if (!existing) {
      await this.runGit(['remote', 'add', 'origin', remote], sourcePath);
      return;
    }
    if (existing !== remote) {
      throw new Error(`GBrain source ${sourceId} remote mismatch: expected ${remote}, found ${existing}.`);
    }
  }

  private async pushSourceIfConfigured(sourceId: string): Promise<void> {
    if (!this.configuredRemote(sourceId)) return;
    await this.run(['sources', 'push', sourceId, '--json']);
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
      await this.assertEmbeddingPlane();
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
    await this.ensureSourceRemote(sourceId, sourcePath);
    let registration = { stdout: '', stderr: '' };
    try {
      registration = await this.run(['sources', 'add', sourceId, '--path', sourcePath, '--force']);
    } catch (error: unknown) {
      // The CLI uses exit code 1 for an already-registered source, even when
      // the registration can be inspected and safely repaired below.
      const message = String(error);
      if (!message.toLowerCase().includes('already registered') && !message.toLowerCase().includes('already exists')) {
        throw error;
      }
      registration = { stdout: '', stderr: message };
    }
    const registrationMessage = `${registration.stdout}\n${registration.stderr}`.toLowerCase();
    if (registrationMessage.includes('already registered') || registrationMessage.includes('already exists')) {
      const existing = await this.registeredSource(sourceId);
      const existingPath = existing?.local_path ? resolve(String(existing.local_path)) : '';
      if (existingPath && existingPath !== resolve(sourcePath)) {
        const pages = Number(existing?.total_pages ?? existing?.page_count ?? 0);
        if (pages > 0) {
          throw new Error(
            `GBrain source ${sourceId} is registered at ${existingPath} with ${pages} page(s), ` +
            `but the application source path is ${resolve(sourcePath)}. Migrate the source explicitly before continuing.`,
          );
        }
        // The stale registration has no indexed data. Rebind it safely while
        // preserving the application's current Git repository on disk.
        await this.run(['sources', 'remove', sourceId, '--confirm-destructive']);
        await this.run(['sources', 'add', sourceId, '--path', sourcePath, '--force']);
      }
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
    const sourceId = this.sourceId(repoPath);
    const sourcePath = await this.ensureSource(sourceId);
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
    if (!(await walk(sourcePath))) return false;
    // A physical Markdown file is not enough: the production incident showed
    // that the app DB can say a document is synced while GBrain has zero pages.
    return (await this.sourcePageCount(sourceId)) > 0;
  }

  async ingest(repoPath: string, evidence: BrainEvidence[]): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    const sourcePath = await this.ensureSource(sourceId);
    await this.ensureSearchConfig();
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
    await this.pushSourceIfConfigured(sourceId);
    await this.syncSource(sourceId, grouped.size);
    // Publish gates must verify the read plane, not merely that a CLI sync
    // command exited successfully. A source can otherwise report a successful
    // write while a page is absent from the query/get plane.
    await this.verifyPages(repoPath, [...grouped.keys()]);
    this.invalidateCache(sourceId);
  }

  async verifyPages(repoPath: string, slugs: string[]): Promise<void> {
    for (const slug of slugs) {
      const page = await this.getPage(repoPath, slug);
      if (!page.trim()) throw new Error(`GBrain verification failed: ${slug} has no readable page content after sync.`);
    }
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
    await this.ensureSearchConfig();
    for (const slug of slugs) {
      await unlink(this.pagePath(sourcePath, slug)).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await this.runGit(['add', '-A'], sourcePath);
    await this.runGit(['commit', '-qm', 'remove knowledge document'], sourcePath);
    await this.pushSourceIfConfigured(sourceId);
    await this.syncSource(sourceId);
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
    await this.pushSourceIfConfigured(sourceId);
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

  /** Invoke an official GBrain memory verb in a source-scoped local context. */
  private async callTool(sourceId: string, tool: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    await this.ensureSource(sourceId);
    await this.ensureSearchConfig();
    const { stdout } = await this.run(['call', '--source', sourceId, tool, JSON.stringify(params)]);
    return this.parseJsonObject(stdout);
  }

  /**
   * Expensive cross-page reasoning for one explicitly authorized Source. The
   * caller is responsible for never combining sources across an ACL boundary.
   */
  async synthesize(repoPath: string, question: string): Promise<BrainSynthesisResult> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'synthesize', { question }) as Promise<BrainSynthesisResult>;
  }

  /** Run GBrain's persisted graph/timeline extraction for one authorized Source. */
  async extract(sourceId: string, options: { ner?: boolean } = {}): Promise<Record<string, any>> {
    await this.ensureSource(sourceId);
    await this.ensureSearchConfig();
    const args = [
      'extract',
      'all',
      '--source',
      'db',
      '--source-id',
      sourceId,
      '--include-frontmatter',
      '--json',
    ];
    if (options.ner) args.splice(args.length - 1, 0, '--ner');
    const { stdout } = await this.run(args);
    return this.parseJsonObject(stdout);
  }

  async remember(repoPath: string, fact: string, provenance: string, entity?: string): Promise<Record<string, any>> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'remember', {
      fact,
      provenance,
      ...(entity ? { entity } : {}),
      visibility: 'private',
    });
  }

  async forget(repoPath: string, id: string): Promise<Record<string, any>> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'forget', { id });
  }

  async recall(repoPath: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'recall', params);
  }

  async getLinks(repoPath: string, slug: string): Promise<Record<string, any>> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'get_links', { slug });
  }

  async contextPack(repoPath: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const sourceId = this.sourceId(repoPath);
    return this.callTool(sourceId, 'context_pack', params);
  }

  async query(repoPath: string, question: string, options: BrainQueryOptions = {}): Promise<BrainQueryResult> {
    const sourceId = this.sourceId(repoPath);
    const operation = options.operation === 'search' ? 'search' : 'query';
    const cacheKey = `${sourceId}:${operation}:${options.breadth ? 'broad' : 'focused'}:${question.trim()}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    await this.ensureSearchConfig();
    // Use GBrain's official balanced retrieval stack as designed: query
    // expansion + vector/BM25/RRF + graph signals + reranker + autocut.
    // No application-side keyword rules or language-specific retries.
    const args = operation === 'search'
      ? [
        'search', question,
        '--source-id', sourceId,
        '--mode', 'balanced',
        '--limit', options.breadth ? '50' : '30',
        '--snippet-chars', '1800',
        '--json',
      ]
      : [
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
    if (operation === 'query') {
      if (options.breadth) args.splice(args.length - 1, 0, '--autocut', 'false');
      else args.splice(args.length - 1, 0, '--adaptive-return', 'true');
    }
    const { stdout } = await this.run(args);
    let rawRows: Array<{ slug: string; title: string; chunk_text?: string; source_id?: string; rerank_score?: number; score?: number; evidence?: string }> = [];
    try { rawRows = JSON.parse(stdout || '[]'); } catch { rawRows = []; }

    // GBrain can return multiple high-scoring chunks from one page. Collapse
    // them into one citation while retaining all distinct evidence snippets.
    const bySlug = new Map<string, { slug: string; title: string; chunk_text: string; source_id?: string; rerank_score?: number; score?: number; evidence?: string }>();
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
    const pageContext = new Map<string, { content: string; section?: string }>();
    for (const row of rows.slice(0, maxParents)) {
      try {
        const page = await this.getPage(repoPath, row.slug);
        if (page && page.length <= remaining) {
          const passage: Passage = options.breadth
            ? { content: page, score: 0 }
            : localizePassage(question, page, row.chunk_text || '');
          pageContext.set(row.slug, { content: passage.content, section: passage.heading });
          remaining -= page.length;
        }
      } catch {
        // A stale page pointer degrades to the retrieved GBrain chunk.
      }
    }
    const citations = rows.map((row) => ({
      topic: row.title || row.slug,
      slug: row.slug,
      sourceKey: row.source_id || sourceId,
      docId: /^docs\/[^/]+$/.test(row.slug) ? row.slug.slice('docs/'.length) : undefined,
      docTitle: row.title,
      snippet: row.chunk_text || '',
      context: pageContext.get(row.slug)?.content || row.chunk_text || '',
      section: pageContext.get(row.slug)?.section,
      score: typeof row.rerank_score === 'number' ? row.rerank_score : row.score,
      evidence: row.evidence,
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
