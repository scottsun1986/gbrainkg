import {
  GitConnector,
  connectorWorkdir,
  parseNameStatus,
  resolveSafeRepoPath,
} from './git-connector';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  readdir: jest.fn(async () => []),
  stat: jest.fn(async () => ({})),
}));

const fsPromises = jest.requireMock('node:fs/promises') as {
  readFile: jest.Mock;
  stat: jest.Mock;
};

const WORKDIR = '/tmp/llmwiki-connectors-test';
const REPO = `${WORKDIR}/repo`;

describe('resolveSafeRepoPath', () => {
  it('accepts a plain repo path under the workdir', () => {
    expect(resolveSafeRepoPath('team-handbook', WORKDIR)).toBe(
      `${WORKDIR}/team-handbook`,
    );
    expect(resolveSafeRepoPath('a/b/repo', WORKDIR)).toBe(`${WORKDIR}/a/b/repo`);
  });

  it('rejects ".." segments', () => {
    expect(() => resolveSafeRepoPath('../etc', WORKDIR)).toThrow(/\.\./);
    expect(() => resolveSafeRepoPath('repo/../../etc', WORKDIR)).toThrow(/\.\./);
    expect(() => resolveSafeRepoPath('..', WORKDIR)).toThrow(/\.\./);
  });

  it('rejects absolute paths that escape the workdir', () => {
    expect(() => resolveSafeRepoPath('/etc/passwd', WORKDIR)).toThrow(/escapes/);
    expect(() =>
      resolveSafeRepoPath('/tmp/llmwiki-connectors-test-evil/x', WORKDIR),
    ).toThrow(/escapes/);
  });

  it('accepts an absolute path that stays inside the workdir', () => {
    expect(resolveSafeRepoPath(`${WORKDIR}/inside`, WORKDIR)).toBe(
      `${WORKDIR}/inside`,
    );
  });

  it('rejects empty repoPath', () => {
    expect(() => resolveSafeRepoPath('', WORKDIR)).toThrow(/required/);
    expect(() => resolveSafeRepoPath('   ', WORKDIR)).toThrow(/required/);
  });

  it('falls back to CONNECTOR_WORKDIR or tmpdir', () => {
    const previous = process.env.CONNECTOR_WORKDIR;
    try {
      process.env.CONNECTOR_WORKDIR = '/tmp/custom-connectors';
      expect(connectorWorkdir()).toBe('/tmp/custom-connectors');
      delete process.env.CONNECTOR_WORKDIR;
      expect(connectorWorkdir()).toContain('llmwiki-connectors');
    } finally {
      if (previous === undefined) delete process.env.CONNECTOR_WORKDIR;
      else process.env.CONNECTOR_WORKDIR = previous;
    }
  });
});

describe('parseNameStatus', () => {
  it('parses A/M/D and rename rows', () => {
    const rows = parseNameStatus(
      ['M\tREADME.md', 'A\tdocs/guide.txt', 'D\told.md', 'R100\tfrom.md\tto.md', ''].join('\n'),
    );
    expect(rows).toEqual([
      { status: 'M', path: 'README.md' },
      { status: 'A', path: 'docs/guide.txt' },
      { status: 'D', path: 'old.md' },
      { status: 'R', previousPath: 'from.md', path: 'to.md' },
    ]);
  });
});

describe('GitConnector', () => {
  let calls: string[][];
  let responses: Record<string, string>;
  let connector: GitConnector;

  beforeEach(() => {
    process.env.CONNECTOR_WORKDIR = WORKDIR;
    calls = [];
    responses = {};
    fsPromises.readFile.mockImplementation(async () => 'file body');
    fsPromises.stat.mockImplementation(async () => ({}));
    connector = new GitConnector(async (args, cwd) => {
      calls.push(args);
      expect(cwd).toBe(REPO);
      const key = args.join(' ');
      if (key in responses) return responses[key];
      throw new Error(`unexpected git call: ${key}`);
    });
  });

  afterEach(() => {
    delete process.env.CONNECTOR_WORKDIR;
  });

  it('testConnection validates the repo path and calls git rev-parse', async () => {
    responses['rev-parse --is-inside-work-tree'] = 'true\n';
    await connector.testConnection({ repoPath: 'repo' });
    expect(calls).toEqual([['rev-parse', '--is-inside-work-tree']]);
  });

  it('testConnection rejects paths that escape the workdir', async () => {
    await expect(
      connector.testConnection({ repoPath: '../../etc' }),
    ).rejects.toThrow(/\.\./);
  });

  it('full scan (no cursor) lists md/txt and returns HEAD as cursor', async () => {
    responses['rev-parse HEAD'] = 'commit-b\n';
    responses['ls-tree -r --name-only commit-b'] =
      'README.md\nimg.png\ndocs/a.txt\n';
    fsPromises.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith('img.png')) throw new Error('binary');
      return `content:${p}`;
    });

    const result = await connector.fetchChanges({ repoPath: 'repo' }, null);
    expect(result.nextCursor).toBe('commit-b');
    expect(result.changes.map((c) => c.externalId).sort()).toEqual([
      'README.md',
      'docs/a.txt',
    ]);
  });

  it('is idempotent for the same cursor: identical changes, stable nextCursor', async () => {
    responses['rev-parse HEAD'] = 'commit-b\n';
    responses['diff --name-status commit-a..commit-b'] =
      'M\tREADME.md\nA\tdocs/new.txt\n';

    const first = await connector.fetchChanges({ repoPath: 'repo' }, 'commit-a');
    const second = await connector.fetchChanges({ repoPath: 'repo' }, 'commit-a');

    expect(first.nextCursor).toBe('commit-b');
    expect(second.nextCursor).toBe('commit-b');
    expect(second.changes.map((c) => c.externalId)).toEqual(
      first.changes.map((c) => c.externalId),
    );
    expect(first.changes.map((c) => c.externalId)).toEqual([
      'README.md',
      'docs/new.txt',
    ]);
  });

  it('returns empty changes when cursor already equals HEAD', async () => {
    responses['rev-parse HEAD'] = 'commit-b\n';
    const result = await connector.fetchChanges(
      { repoPath: 'repo' },
      'commit-b',
    );
    expect(result.changes).toEqual([]);
    expect(result.nextCursor).toBe('commit-b');
  });

  it('emits deleted markers for D rows and keeps only md/txt', async () => {
    responses['rev-parse HEAD'] = 'commit-c\n';
    responses['diff --name-status commit-b..commit-c'] =
      'D\tdocs/gone.md\nM\timg.png\nM\tkeep.txt\n';

    const result = await connector.fetchChanges({ repoPath: 'repo' }, 'commit-b');
    expect(result.changes).toHaveLength(2);
    const deleted = result.changes.find((c) => c.externalId === 'docs/gone.md');
    expect(deleted?.deleted).toBe(true);
    expect(result.changes.find((c) => c.externalId === 'keep.txt')?.deleted).toBeFalsy();
    expect(result.changes.find((c) => c.externalId === 'img.png')).toBeUndefined();
  });
});
