import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../prisma';
import { getRequestContext } from '../observability/request-context';

type Tx = Prisma.TransactionClient;

/**
 * RLS 会话上下文。请求路径用 forUser 固定 app.user_id；
 * 后台任务（ingest/embed/graph/brain）必须显式 forService，否则 fail-closed。
 * 仅在 RLS_ENFORCE=1 且运行时角色 NOBYPASSRLS 时真正拦截；否则行为等价于直接回调。
 */
@Injectable()
export class TenantContextService {
  private readonly logger = new Logger(TenantContextService.name);
  private readonly prisma: PrismaClient;
  private readonly enforce: boolean;

  constructor() {
    this.prisma = getPrismaClient();
    this.enforce = String(process.env.RLS_ENFORCE ?? '').toLowerCase() === '1';
  }

  get isEnforced(): boolean {
    return this.enforce;
  }

  private async apply(tx: Tx, userId: string | null, service: boolean) {
    const uid = userId ?? '';
    const svc = service ? 'on' : 'off';
    await tx.$executeRaw`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx.$executeRaw`SELECT set_config('app.service', ${svc}, true)`;
    if (this.enforce && !service && !userId) {
      throw new Error('TenantContext: refusing query without user or service context');
    }
  }

  async forUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.apply(tx, userId, false);
      return fn(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async forService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (getRequestContext() && !getRequestContext()?.servicePrincipal) throw new Error('Cannot promote request to service');
    return this.prisma.$transaction(async (tx) => {
      await this.apply(tx, null, true);
      return fn(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  /** 只读、短查询用；长事务请用 forUser/forService。 */
  async forUserRead<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.forUser(userId, fn);
  }
}

/** 批量向量写入的安全拼接：仅接受 UUID + 数值向量字符串。 */
export function formatVectorValues(
  items: Array<{ id: string; vec: string }>,
): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const vecRe = /^\[[-0-9.eE+,\s]+\]$/;
  return items
    .map((item) => {
      if (!uuidRe.test(item.id)) throw new Error(`formatVectorValues: invalid uuid ${item.id}`);
      if (!vecRe.test(item.vec)) throw new Error(`formatVectorValues: invalid vector payload`);
      const literal = item.vec.replace(/\s+/g, '');
      return `('${item.id}'::uuid, '${literal}'::vector)`;
    })
    .join(',');
}

type RawCapable = {
  $transaction?: (fn: (tx: any) => Promise<any>, opts?: any) => Promise<any>;
  $executeRaw?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  [key: string]: any;
};

/**
 * 后台/维护路径的 RLS 上下文：在事务内 set_config('app.service','on')，
 * 与 TenantContextService.forService 语义一致，但不依赖 Nest DI。
 *
 * 请求路径修正：该 helper 也被请求内的检索臂调用（BGE-M3 稀疏召回、语义缓存
 * 查询等）。此前它无条件覆写为 service 上下文，等于把请求用户的 RLS 上下文
 * 降级为 service（绕过行级权限），文档级 ACL 只剩应用层一道防线。现在：存在
 * 请求用户时保留该用户上下文（service='off'），只有真正的后台任务才使用
 * service 上下文。
 *
 * 仅当客户端同时具备 $transaction + $executeRaw 时才开启事务作用域；
 * 单测替身（缺少其中任一原语）直接执行回调，保持既有 mock 断言不变。
 *
 * 返回 Promise<any>：调用点多为 tagged-template 原始 SQL（本身 any），
 * 泛型推断会把 T 塌成 unknown/{} 并破坏既有 `.filter` 等链式调用。
 */
export async function withServiceContext(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<any>,
): Promise<any> {
  if (!prisma || typeof prisma.$transaction !== 'function' || typeof prisma.$executeRaw !== 'function') {
    return fn(prisma);
  }
  return prisma.$transaction(async (tx: any) => {
    if (!tx || typeof tx.$executeRaw !== 'function') {
      return fn(prisma);
    }
    const context = getRequestContext();
    const requestUserId = context?.userId;
    if (context && !context.servicePrincipal) {
      // 请求内调用：保留用户上下文，RLS 策略按请求用户判定。
      await tx.$executeRaw`SELECT set_config('app.user_id', ${requestUserId || ''}, true), set_config('app.service', 'off', true), set_config('app.as_of', ${new Date(context?.asOf ?? Date.now()).toISOString()}, true)`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.user_id', '', true), set_config('app.service', 'on', true), set_config('app.as_of', ${new Date(context?.asOf ?? Date.now()).toISOString()}, true)`;
    }
    if (context?.artifactInputs) await tx.$executeRaw`SELECT set_config('app.artifact_inputs', ${context.artifactInputs}, true)`;
    return fn(tx);
  }, { isolationLevel: 'ReadCommitted' });
}

/**
 * 已授权管理面清单的只读 RLS 上下文：显式 service 范围（app.service='on'）。
 *
 * 为什么管理面不能用请求用户上下文跑清单：清单查询大量使用跨用户的
 * to-one include（OrgNode.admins.user、KbAdmin.user、CompileJob.user）。
 * 行级策略一旦按"请求用户可见行"过滤被 join 的 User，Prisma 的 required
 * relation 就会得到 null 并抛 "Inconsistent query result" 直接 500
 * （2026-10-06 E2E BUG-3：子组织管理员 /admin/data 必现）。
 *
 * 安全边界：调用方必须在应用层完成授权与范围裁剪。admin.controller 的
 * getAllData 已经按 capabilities / managedOrgIds / visibleKbs 收敛
 * directoryUsers、orgs、grants、documents——那些应用层裁剪是权威语义
 * （组织管理员=本级+下级），不要依赖 RLS 在这里做二次过滤。
 */
export async function withAdminInventory(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<any>,
): Promise<any> {
  return withElevatedContext(prisma, fn, true);
}

/** 内部授权计算只读入口。关系数据仅用于权限裁决，不直接返回用户清单。 */
export async function withPermissionRead<T>(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<T>,
): Promise<T> {
  return withElevatedContext(prisma, fn, true);
}

/**
 * Authentication-only database context.
 *
 * Reads that decide *whether* an identity authenticates (login by username,
 * JWT subject status, OIDC binding, MFA challenge, MCP app credentials) run
 * before `app.user_id` is known, so no user-scoped RLS policy can authorize
 * them. They run here with `app.service=on` inside one transaction.
 *
 * This deliberately skips `forService`'s "cannot promote a request to service"
 * guard: that guard protects request-scoped business work, whereas these call
 * sites only read identity rows to decide authentication and never run
 * caller-supplied logic on the result. Keep it confined to authentication —
 * every new use widens the hole in user-scoped isolation.
 */
export async function runAsAuth<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', '', true)`;
    await tx.$executeRaw`SELECT set_config('app.service', 'on', true)`;
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/**
 * Service-identity transaction for a *system* write that a request legitimately
 * triggers.
 *
 * Why this exists: `withServiceContext` deliberately keeps the caller's USER
 * identity inside a request (`app.service='off'`), and `runAsService` refuses to
 * promote a request identity at all. Neither can write tables whose RLS policies
 * are service-only — yet several request-reachable flows must write exactly
 * those tables (version/index artifacts), because they are system-owned derived
 * data. `POST /api/v1/documents/:id/versions` failed with a 42501 on
 * `DocumentVersionLink` for precisely this reason.
 *
 * The caller MUST have authorized the user against the target resource before
 * calling this: everything written inside runs as the service identity and is
 * therefore NOT constrained by the user's row visibility. Keep the body limited
 * to derived/system artifacts — never to a user-scoped decision.
 */
export async function withSystemWrite<T>(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<T>,
): Promise<T> {
  return withElevatedContext(prisma, fn, false);
}

async function withElevatedContext<T>(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<T>,
  readOnly: boolean,
): Promise<T> {
  if (!prisma || typeof prisma.$transaction !== 'function' || typeof prisma.$executeRaw !== 'function') {
    return fn(prisma);
  }
  return prisma.$transaction(async (tx: any) => {
    if (!tx || typeof tx.$executeRaw !== 'function') return fn(prisma);
    if (readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const context = getRequestContext();
    await tx.$executeRaw`SELECT set_config('app.user_id', '', true), set_config('app.service', 'on', true), set_config('app.as_of', ${new Date(context?.asOf ?? Date.now()).toISOString()}, true)`;
    return fn(tx);
  }, { isolationLevel: 'ReadCommitted' });
}
