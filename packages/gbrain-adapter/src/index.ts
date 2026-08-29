declare const require: any;
declare const process: any;

const { mkdir, writeFile, access } = require('node:fs').promises;
const { join } = require('node:path');
const { spawn } = require('node:child_process');

export interface BrainEvidence {
  text: string;
  sourceFile?: string;
  kbId?: string;
  topic?: string;
  slug?: string;
}

export interface BrainQueryResult {
  topics: string[];
  answer: string;
  citations: Array<{ topic: string; kbId?: string; docId?: string; docTitle?: string; snippet: string }>;
}

function safePart(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user';
}

function sourceIdForUser(userId: string): string {
  return `llmwiki-${safePart(userId.replace(/-/g, '').slice(0, 16))}`.slice(0, 32);
}

function stripPrismaUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    return url.toString();
  } catch {
    return value;
  }
}

/** Production bridge to the official garrytan/gbrain CLI. */
export class BrainRepoAdapter {
  private readonly gbrainBin = process.env.GBRAIN_BIN || '/home/scottsun/.bun/bin/gbrain';
  private readonly gbrainHome = process.env.GBRAIN_HOME || '/home/scottsun/.config/gbrain';
  private readonly sourceRoot: string;

  constructor(basePath: string) {
    this.sourceRoot = join(basePath, 'gbrain-sources');
  }

  private sourceId(repoPath: string): string {
    const match = /^gbrain:\/\/source\/(.+)$/.exec(repoPath);
    if (!match) throw new Error(`Invalid GBrain source reference: ${repoPath}`);
    return match[1];
  }

  private async run(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
    const env = {
      ...process.env,
      GBRAIN_HOME: this.gbrainHome,
      PATH: `/home/scottsun/.bun/bin:${process.env.PATH || ''}`,
      DATABASE_URL: stripPrismaUrl(process.env.DATABASE_URL || ''),
    };
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
    });
  }

  private async ensureSource(sourceId: string): Promise<string> {
    const sourcePath = join(this.sourceRoot, sourceId);
    await mkdir(sourcePath, { recursive: true });
    try { await access(join(sourcePath, '.git')); } catch {
      await writeFile(join(sourcePath, '.gbrain-source'), `${sourceId}\n`, 'utf8');
      await this.runGit(['init', '-q'], sourcePath);
      await this.runGit(['config', 'user.email', 'llmwiki@local'], sourcePath);
      await this.runGit(['config', 'user.name', 'LLMWiki'], sourcePath);
      await this.runGit(['add', '.gbrain-source'], sourcePath);
      await this.runGit(['commit', '-qm', 'initialize source'], sourcePath);
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

  async ingest(repoPath: string, evidence: BrainEvidence[]): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    await this.ensureSource(sourceId);
    const grouped = new Map<string, BrainEvidence[]>();
    for (const item of evidence) {
      const slug = item.slug || `docs/${safePart(item.topic || 'document')}`;
      grouped.set(slug, [...(grouped.get(slug) || []), item]);
    }
    for (const [slug, items] of grouped) {
      const content = items.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
      if (content) {
        await this.run(['capture', '--stdin', '--slug', slug, '--type', 'analysis', '--source', sourceId], content);
        // Capture writes the page/chunks; explicitly embed it so newly
        // published documents are searchable immediately in production.
        await this.run(['embed', slug, '--source', sourceId]);
      }
    }
  }

  async replace(repoPath: string, evidence: BrainEvidence[]): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    await this.ensureSource(sourceId);
    await this.run(['sources', 'remove', sourceId, '--confirm-destructive']).catch(() => undefined);
    await this.ensureSource(sourceId);
    await this.ingest(repoPath, evidence);
  }

  async delete(repoPath: string, slug: string): Promise<void> {
    const sourceId = this.sourceId(repoPath);
    await this.run(['delete', slug, '--source', sourceId]).catch((error) => {
      if (!String(error).toLowerCase().includes('not found')) throw error;
    });
  }

  async query(repoPath: string, question: string): Promise<BrainQueryResult> {
    const sourceId = this.sourceId(repoPath);
    // Keep enough candidates for enumeration questions. The application still
    // applies its database ACL after this retrieval step.
    const isFullDocument = /(全文|全篇|整篇|全部章节|完整内容|全部内容|逐条|逐项|多少|几条|总数|一共|共有|条款|条数|数量|完整|全部)/u.test(question);
    const runQuery = async (candidate: string) => {
      const { stdout } = await this.run(['query', candidate, '--no-expand', '--source-id', sourceId, '--limit', isFullDocument ? '40' : '24', '--detail', 'high', '--snippet-chars', '0', '--autocut', 'false', '--json']);
      try {
        return JSON.parse(stdout || '[]') as Array<{ slug: string; title: string; chunk_text?: string; source_id?: string }>;
      } catch {
        return [];
      }
    };
    let rows = await runQuery(question);
    // GBrain's keyword arm can treat a continuous Chinese question such as
    // "合规管理办法第一条是什么" as one long token. Retry progressively
    // shorter Han prefixes so title phrases remain searchable while the
    // retrieval engine is still exclusively GBrain (no DB text fallback).
    if (/[\p{Script=Han}]/u.test(question)) {
      const hanRun = ((question.match(/[\p{Script=Han}]{4,}/gu) || []).sort((a, b) => b.length - a.length)[0] || '')
        .replace(/^(请问|请告诉我|帮我查一下|帮我查询|请帮我)/u, '');
      const lengths = [16, 14, 12, 10, 8, 6, 5, 4].filter((length) => length <= hanRun.length);
      const bySlug = new Map(rows.map((row) => [row.slug, row]));
      for (const length of lengths) {
        const candidate = hanRun.slice(0, length);
        const variants = await runQuery(candidate);
        const relevant = variants.filter((row) => `${row.title || ''}\n${row.chunk_text || ''}`.includes(candidate));
        for (const row of relevant) if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
        // Once a title/content-bearing variant is found, shorter prefixes are
        // less precise and can only add noisy candidates.
        if (relevant.length) break;
      }
      rows = [...bySlug.values()];
    }
    // Hybrid query is intentionally top-K. For enumeration/complete-document
    // questions, recover the canonical full GBrain pages for the matched docs;
    // otherwise a five-hundred-line policy can be mistaken for a partial answer.
    if (isFullDocument) {
      const pageCache = new Map<string, string>();
      for (const row of rows) {
        if (!row.slug || pageCache.has(row.slug)) continue;
        try {
          const page = await this.getPage(repoPath, row.slug);
          if (page) pageCache.set(row.slug, page);
        } catch {
          // Retrieval remains usable when an old index points to a removed page.
        }
      }
      for (const row of rows) {
        const full = pageCache.get(row.slug);
        if (full) row.chunk_text = full;
      }
    }
    return {
      topics: rows.map((row) => row.title || row.slug),
      answer: rows.map((row) => row.chunk_text || '').filter(Boolean).join('\n\n'),
      citations: rows.map((row) => ({
        topic: row.title || row.slug,
        docId: row.slug.startsWith('docs/') ? row.slug.slice('docs/'.length) : undefined,
        docTitle: row.title,
        snippet: row.chunk_text || '',
      })),
    };
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
  async queryMany(repoPaths: string[], question: string): Promise<BrainQueryResult> {
    const results = await Promise.all(repoPaths.map((repoPath) => this.query(repoPath, question)));
    const citations = results.flatMap((result) => result.citations || []);
    const unique = new Map<string, BrainQueryResult['citations'][number]>();
    for (const citation of citations) {
      const key = `${citation.kbId || ''}:${citation.docId || citation.topic}`;
      if (!unique.has(key)) unique.set(key, citation);
    }
    const merged = [...unique.values()].slice(0, 20);
    return {
      topics: merged.map((citation) => citation.topic),
      answer: merged.map((citation) => citation.snippet).filter(Boolean).join('\n\n'),
      citations: merged,
    };
  }
}
