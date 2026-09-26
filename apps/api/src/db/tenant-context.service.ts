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
    const requestUserId = getRequestContext()?.userId;
    if (requestUserId) {
      // 请求内调用：保留用户上下文，RLS 策略按请求用户判定。
      await tx.$executeRaw`SELECT set_config('app.user_id', ${requestUserId}, true), set_config('app.service', 'off', true)`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.user_id', '', true), set_config('app.service', 'on', true)`;
    }
    return fn(tx);
  }, { isolationLevel: 'ReadCommitted' });
}
