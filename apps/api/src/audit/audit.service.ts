import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class AuditService {
  private prisma = new PrismaClient();

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
      // Assuming auditLog model is defined in Prisma schema
      await (this.prisma as any).auditLog.create({ data: params });
    } catch (error) {
      // Don't let audit failures break the main flow
      console.error('Audit log failed:', error);
    }
  }
}
