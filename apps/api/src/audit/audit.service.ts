import { Injectable } from '@nestjs/common';
import { getPrismaClient } from '../prisma';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditService {
  private prisma = getPrismaClient();

  async log(params: {
    userId?: string;
    action: string;
    resource?: string;
    resourceId?: string;
    details?: any;
    ipAddress?: string;
    userAgent?: string;
  }) {
    try {
      // userId/resourceId are uuid columns; non-uuid identities (e.g. the
      // attempted username of a failed login) are preserved in details.
      const data: Record<string, unknown> = {
        action: params.action,
        resource: params.resource,
        details: params.details,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      };
      if (params.resourceId && UUID_RE.test(params.resourceId))
        data.resourceId = params.resourceId;
      if (params.userId && UUID_RE.test(params.userId)) {
        data.userId = params.userId;
      } else if (params.userId) {
        data.details = {
          ...(params.details && typeof params.details === 'object'
            ? params.details
            : {}),
          attemptedIdentity: params.userId,
        };
      }
      // createMany, not create: PostgreSQL evaluates the table's SELECT policies
      // against the row produced by INSERT ... RETURNING, and PostgreSQL reports
      // a denial there as "new row violates row-level security policy" (the
      // WITH CHECK wording), which is misleading. Audit rows are readable only by
      // service/administrators, so every non-admin insert — including a failed
      // login — was rejected on the RETURNING read. The caller does not need the
      // row back, so emit a plain INSERT.
      await (this.prisma as any).auditLog.createMany({ data: [data] });
    } catch (error) {
      // Don't let audit failures break the main flow
      console.error('Audit log failed:', error);
    }
  }
}
