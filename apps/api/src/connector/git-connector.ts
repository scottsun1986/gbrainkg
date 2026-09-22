import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  ConnectorChange,
  EnterpriseConnector,
  FetchChangesResult,
} from './types';

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const TEXT_EXTENSIONS = new Set(['.md', '.txt']);

export function connectorWorkdir(): string {
  const configured = String(process.env.CONNECTOR_WORKDIR || '').trim();
  return resolve(configured || join(tmpdir(), 'llmwiki-connectors'));
}

/**
 * 安全路径解析：仓库路径必须落在 CONNECTOR_WORKDIR（或 tmpdir）之下。
 * 显式拒绝 `..` 段、绝对路径逃逸、以及 resolve 后跳出根目录的输入。
 */
export function resolveSafeRepoPath(
  repoPath: string,
  workdir: string = connectorWorkdir(),
): string {
  const raw = String(repoPath || '').trim();
  if (!raw) throw new Error('repoPath is required');
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    throw new Error('unsafe repo path: ".." segments are forbidden');
  }
  if (segments.some((seg) => seg === '.' || seg === '')) {
    // "." is harmless but normalize below; empty handled by filter
  }
  const root = resolve(workdir);
  const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const escaped =
    target !== root &&
    !target.startsWith(root.endsWith(sep) ? root : root + sep);
  if (escaped) {
    throw new Error('unsafe repo path: escapes connector workdir');
  }
  return target;
}

function isTextPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

async function defaultGitRunner(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function parseNameStatus(
  output: string,
): Array<{ status: string; path: string; previousPath?: string }> {
  const rows: Array<{ status: string; path: string; previousPath?: string }> =
    [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Formats: "M\tpath", "R100\told\tnew", "D\tpath"
    const parts = trimmed.split('\t');
    const status = (parts[0] || '').trim();
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (parts.length >= 3) {
        rows.push({
          status: status.slice(0, 1),
          previousPath: parts[1],
          path: parts[2],
        });
      }
      continue;
    }
    if (parts.length >= 2) {
      rows.push({ status: status.slice(0, 1), path: parts[1] });
    }
  }
  return rows;
}

/**
 * Git 连接器：扫描本地仓库中的 md/txt。
 * cursor = 上次同步的 commit sha；空 cursor 走全量（HEAD 树）。
 */
export class GitConnector implements EnterpriseConnector {
  readonly kind = 'git';

  constructor(private readonly runGit: GitRunner = defaultGitRunner) {}

  private resolveRepo(config: Record<string, unknown>): string {
    const repoPath = String(config.repoPath || config.repo || '');
    return resolveSafeRepoPath(repoPath);
  }

  async testConnection(config: Record<string, unknown>): Promise<void> {
    const repo = this.resolveRepo(config);
    await stat(repo).catch(() => {
      throw new Error(`git repo not found: ${repo}`);
    });
    await this.runGit(['rev-parse', '--is-inside-work-tree'], repo);
  }

  async fetchChanges(
    config: Record<string, unknown>,
    cursor: string | null,
  ): Promise<FetchChangesResult> {
    const repo = this.resolveRepo(config);
    const ref = String(config.ref || 'HEAD');
    const from = cursor && cursor.trim() ? cursor.trim() : null;
    const to = (await this.runGit(['rev-parse', ref], repo)).trim();

    const changes: ConnectorChange[] = [];

    if (!from) {
      // 全量：列出 HEAD 树中的 md/txt
      const listing = await this.runGit(['ls-tree', '-r', '--name-only', to], repo);
      for (const rel of listing.split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (!isTextPath(rel)) continue;
        // 再次走安全路径（防御符号链接/异常文件名）
        const abs = resolveSafeRepoPath(rel, repo);
        let content = '';
        try {
          content = await readFile(abs, 'utf8');
        } catch {
          continue;
        }
        changes.push({
          externalId: rel,
          title: rel.split('/').pop() || rel,
          content,
          metadata: { status: 'A' },
        });
      }
      return { changes, nextCursor: to };
    }

    if (from === to) {
      // 幂等：游标未推进时返回空集
      return { changes: [], nextCursor: to };
    }

    const diff = await this.runGit(
      ['diff', '--name-status', `${from}..${to}`],
      repo,
    );
    for (const row of parseNameStatus(diff)) {
      if (!isTextPath(row.path)) continue;
      if (row.status === 'D') {
        changes.push({
          externalId: row.path,
          title: row.path.split('/').pop() || row.path,
          content: '',
          deleted: true,
          metadata: { status: 'D' },
        });
        continue;
      }
      const abs = resolveSafeRepoPath(row.path, repo);
      let content = '';
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      changes.push({
        externalId: row.path,
        title: row.path.split('/').pop() || row.path,
        content,
        metadata: { status: row.status, previousPath: row.previousPath },
      });
    }
    return { changes, nextCursor: to };
  }
}

/** 仅用于测试/工具：列出仓库中的文本文件。 */
export async function listTextFiles(repoDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (isTextPath(entry.name)) out.push(full);
    }
  }
  await walk(repoDir);
  return out;
}
