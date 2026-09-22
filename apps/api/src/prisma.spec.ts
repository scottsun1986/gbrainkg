describe('prisma connection pool bounding', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('appends an explicit connection limit when configured', () => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db?schema=public';
      process.env.PRISMA_CONNECTION_LIMIT = '7';
      process.env.PRISMA_POOL_TIMEOUT_SECONDS = '15';
      require('./prisma');
      expect(process.env.DATABASE_URL).toContain('connection_limit=7');
      expect(process.env.DATABASE_URL).toContain('pool_timeout=15');
    });
  });

  it('never overrides an explicitly configured pool', () => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db?connection_limit=3';
      process.env.PRISMA_CONNECTION_LIMIT = '99';
      require('./prisma');
      expect(process.env.DATABASE_URL).toContain('connection_limit=3');
      expect(process.env.DATABASE_URL).not.toContain('connection_limit=99');
    });
  });

  it('leaves the URL untouched when no limit is configured', () => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
      delete process.env.PRISMA_CONNECTION_LIMIT;
      require('./prisma');
      expect(process.env.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db');
    });
  });
});
