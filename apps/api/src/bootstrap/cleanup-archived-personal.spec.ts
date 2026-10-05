import { assertLocalCleanupConfiguration } from './cleanup-archived-personal';
describe('Local archived cleanup CLI guard', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:5432/local_test';
    process.env.ARCHIVED_CLEANUP_LOCAL_DATABASE = 'local_test';
    process.env.UPLOAD_ROOT = '/tmp/cleanup-test/uploads';
    process.env.BRAIN_REPO_BASE_PATH = '/tmp/cleanup-test/brain_repos';
    delete process.env.ARCHIVED_CLEANUP_ENABLE; delete process.env.MINIO_ENDPOINT;
  });
  afterEach(() => { process.env = { ...saved }; });
  it('allows read-only preview with explicit local configuration and closed kill-switch', () => {
    expect(() => assertLocalCleanupConfiguration(false)).not.toThrow();
  });
  it('requires execution kill-switch', () => {
    expect(() => assertLocalCleanupConfiguration(true)).toThrow('kill-switch');
    process.env.ARCHIVED_CLEANUP_ENABLE = '1'; expect(() => assertLocalCleanupConfiguration(true)).not.toThrow();
  });
  it('refuses remote database, mismatched basename and missing namespace', () => {
    process.env.DATABASE_URL = 'postgresql://test@remote.invalid:5432/local_test';
    expect(() => assertLocalCleanupConfiguration(false)).toThrow('local database');
    process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:5432/another';
    expect(() => assertLocalCleanupConfiguration(false)).toThrow('local database');
    process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:5432/local_test'; delete process.env.UPLOAD_ROOT;
    expect(() => assertLocalCleanupConfiguration(false)).toThrow('runtime UPLOAD_ROOT');
  });
  it('refuses a remote object storage target even with a local DB', () => {
    process.env.MINIO_ENDPOINT = 'https://remote.invalid';
    expect(() => assertLocalCleanupConfiguration(false)).toThrow('Local object storage');
  });
  it.each(['UPLOAD_ROOT', 'BRAIN_REPO_BASE_PATH'])('refuses cwd-dependent %s for execute and verify', key => {
    process.env[key] = './storage';
    process.env.ARCHIVED_CLEANUP_ENABLE = '1';
    expect(() => assertLocalCleanupConfiguration(true)).toThrow('Explicit absolute');
    expect(() => assertLocalCleanupConfiguration(false)).toThrow('Explicit absolute');
  });
});
