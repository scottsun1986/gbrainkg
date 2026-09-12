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
      await (this.prisma as any).auditLog.create({ data });
    } catch (error) {
      // Don't let audit failures break the main flow
      console.error('Audit log failed:', error);
    }
  }
}
