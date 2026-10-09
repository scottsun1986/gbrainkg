describe('prisma connection pool bounding', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Each case supplies its own URL. A runtime-role URL inherited from CI or
    // a developer shell would otherwise replace that fixture at module load.
    delete process.env.DATABASE_URL_APP;
    delete process.env.LLMWIKI_FORCE_MIGRATOR_URL;
  });

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

  it('divides the host connection budget across instances and processes', () => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
      delete process.env.PRISMA_CONNECTION_LIMIT;
      process.env.SHARED_INSTANCE_COUNT = '10';
      process.env.DB_PROCESSES_PER_INSTANCE = '2';
      process.env.DB_CONNECTION_BUDGET = '80';
      require('./prisma');
      const match = process.env.DATABASE_URL!.match(/connection_limit=(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(4);
    });
  });

  it.each(['bad','0','100'])('rejects impossible instance allocation %s instead of opening an unbounded pool', count => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL='postgresql://u:p@localhost:5432/db';
      delete process.env.PRISMA_CONNECTION_LIMIT;
      process.env.SHARED_INSTANCE_COUNT=count;process.env.DB_CONNECTION_BUDGET='80';process.env.DB_PROCESSES_PER_INSTANCE='2';
      expect(() => require('./prisma')).toThrow('Invalid shared database');
    });
  });
});
