import { PrismaClient } from '@prisma/client';

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid database role or name');
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const role = process.env.DB_USER_APP || 'llmwiki_app';
  const password = process.env.DB_PASS_APP;
  const dbName = process.env.DB_NAME;
  if (!password || !dbName) throw new Error('DB_PASS_APP and DB_NAME are required to provision the runtime database role');
  const qRole = quoteIdentifier(role);
  const qDb = quoteIdentifier(dbName);
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists', role,
    );
    if (!existing[0]?.exists) {
      await prisma.$executeRawUnsafe(`CREATE ROLE ${qRole} LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD ${quoteLiteral(password)}`);
    } else {
      await prisma.$executeRawUnsafe(`ALTER ROLE ${qRole} LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD ${quoteLiteral(password)}`);
    }
    await prisma.$executeRawUnsafe(`ALTER ROLE ${qRole} RESET "app.service"`);
    await prisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${qDb} TO ${qRole}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${qRole}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${qRole}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${qRole}`);
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qRole}`);
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${qRole}`);
    process.stdout.write(`Runtime database role ${role} provisioned with NOBYPASSRLS.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
