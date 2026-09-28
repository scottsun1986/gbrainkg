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

  it('applies the default pool floor when no limit is configured', () => {
    jest.isolateModules(() => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
      delete process.env.PRISMA_CONNECTION_LIMIT;
      require('./prisma');
      // RLS 把每次独立查询都变成交互式事务，后台 BullMQ 消费者会合法占用
      // 连接；num_cpus 派生的小池（5~9）会被饿死，因此未配置时应用 16 的下限。
      const match = process.env.DATABASE_URL!.match(/connection_limit=(\d+)/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(16);
    });
  });
});
