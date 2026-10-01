import { getPrismaClient } from './src/prisma';
import { runWithRequestContext, setRequestContextUser } from './src/observability/request-context';
import { withServiceContext } from './src/db/tenant-context.service';

const ADMIN = '0e7a51f6-f4c3-46a0-87bd-d23d4d7280d4';
const timed = async (label: string, fn: () => Promise<any>) => {
  const t = Date.now();
  const r = await fn();
  console.log(`${label}: ${Date.now() - t}ms`);
  return r;
};

(async () => {
  const prisma = getPrismaClient();
  await runWithRequestContext({ requestId: 'perf', userId: ADMIN }, async () => {
    setRequestContextUser(ADMIN);
    await withServiceContext(prisma, async (db: any) => {
      await timed('users.findMany', () => db.user.findMany({ take: 1000, orderBy: { createdAt: 'asc' }, select: { id: true, username: true, displayName: true, email: true, status: true, roles: { select: { role: { select: { id: true, name: true, code: true, permissions: true } } } }, orgs: { select: { orgNode: { select: { id: true, name: true, path: true } } } } } }));
      await timed('kbs.findMany(include admins+_count)', () => db.knowledgeBase.findMany({
        where: { status: 'active' },
        include: {
          admins: { include: { user: { select: { id: true, username: true, displayName: true, email: true, status: true } } } },
          _count: { select: { documents: true } },
        },
        take: 1000,
      }));
      await timed('grants', () => prisma.industryGrant.findMany({ select: { id: true, kbId: true, subjectType: true, subjectId: true, grantedById: true, expiresAt: true, createdAt: true }, take: 1000 }));
      await timed('compileJobs(20)', () => db.compileJob.findMany({ select: { id: true }, take: 20 }));
      await timed('documents(20)', () => db.document.findMany({ select: { id: true, kbId: true, title: true, status: true, updatedAt: true }, take: 20, orderBy: { updatedAt: 'desc' } }));
      await timed('auditLogs(50)', () => db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
      await timed('compileJobs.full(1000)', () => db.compileJob.findMany({ select: { id: true, inputEvidenceIds: true }, take: 1000, orderBy: { createdAt: 'desc' } }));
      await timed('document.count(247 kbIds)', () => db.document.count({ where: { kb: { type: 'personal' } } }));
    });
  });
  process.exit(0);
})().catch((e) => { console.error('FAIL', e?.message || e); process.exit(1); });
