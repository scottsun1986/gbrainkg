import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../prisma';

type Tx = Prisma.TransactionClient;

/**
 * 数据库事务上下文助手。
 *
 * 行级安全(RLS)已移除，权限语义完全由应用层负责。此处保留原有函数签名以
 * 兼容既有调用点，但不再设置 RLS 会话 GUC（app.user_id / app.service /
 * app.as_of），也不再做 service/user 上下文校验——每个入口只提供一个普通
 * 只读或读写事务。
 *
 * 安全边界：调用方必须在应用层独立完成鉴权与资源范围裁剪，数据库不再提供
 * 任何兜底隔离（参见 docs/RLS-BOUNDARIES.md）。
 */
@Injectable()
export class TenantContextService {
  private readonly prisma: PrismaClient;

  constructor() {
    this.prisma = getPrismaClient();
  }

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async forUser<T>(_userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  async forService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  /** 只读、短查询用；长事务请用 forUser/forService。 */
  async forUserRead<T>(_userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn);
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
  [key: string]: any;
};

/**
 * 通用事务包装：可用时在事务内执行回调，否则直接执行（单测替身通常缺少
 * $transaction，直接降级执行以保持既有 mock 断言不变）。
 *
 * 返回 Promise<any>：调用点多为 tagged-template 原始 SQL（本身 any），
 * 泛型推断会把 T 塌成 unknown/{} 并破坏既有 `.filter` 等链式调用。
 */
export async function withServiceContext(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<any>,
): Promise<any> {
  if (!prisma || typeof prisma.$transaction !== 'function') return fn(prisma);
  return prisma.$transaction((tx: any) => fn(tx), { isolationLevel: 'ReadCommitted' });
}

/** 管理面清单读入口。原为显式 service RLS 范围，现为普通事务。 */
export async function withAdminInventory(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<any>,
): Promise<any> {
  return withServiceContext(prisma, fn);
}

/** 内部授权计算只读入口。原为显式提权 RLS 读，现为普通事务。 */
export async function withPermissionRead<T>(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<T>,
): Promise<T> {
  return withServiceContext(prisma, fn);
}

/**
 * 认证阶段的数据库入口。原用于在 app.user_id 尚未确定时读取身份行；移除
 * RLS 后与普通事务一致，保留签名供既有调用点使用。
 */
export async function runAsAuth<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const prisma = getPrismaClient();
  return prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** 系统产物写入入口。原以 service 身份绕过 RLS 写入派生/系统数据。 */
export async function withSystemWrite<T>(
  prisma: RawCapable | null | undefined,
  fn: (client: any) => Promise<T>,
): Promise<T> {
  return withServiceContext(prisma, fn);
}
