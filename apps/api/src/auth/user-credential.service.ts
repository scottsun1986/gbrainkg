import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { createHash, randomBytes } from 'node:crypto';
import {
  decryptModelCredential,
  encryptModelCredential,
} from '../model-credential';

export interface UserCredentialDto {
  id: string;
  appId: string;
  name: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  maskedSecret: string;
}

export interface CreatedCredentialDto extends UserCredentialDto {
  appSecret: string;
  note: string;
}

@Injectable()
export class UserCredentialService {
  private readonly prisma = getPrismaClient();

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private generateAppId(custom?: string): string {
    if (custom && custom.trim()) {
      const trimmed = custom.trim();
      if (!/^app_[A-Za-z0-9_.\-]{4,60}$/.test(trimmed)) {
        throw new BadRequestException(
          'appId 格式不合法，须以 app_ 开头，长度 8~64 位，仅包含字母、数字、点、下划线及减号',
        );
      }
      return trimmed;
    }
    return `app_${randomBytes(8).toString('hex')}`;
  }

  private generateAppSecret(): string {
    return `sec_${randomBytes(24).toString('base64url')}`;
  }

  private maskSecret(secret?: string | null): string {
    if (!secret) return 'sec_••••••••••••••••';
    const clean = secret.trim();
    if (clean.length <= 8) return 'sec_••••';
    return `sec_••••••••${clean.slice(-4)}`;
  }

  async getCredentials(userId: string): Promise<UserCredentialDto[]> {
    const list = await this.prisma.userCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    // If user has no credentials yet, automatically provision a default one
    if (list.length === 0) {
      const defaultCred = await this.createDefaultCredential(userId);
      return [
        {
          id: defaultCred.id,
          appId: defaultCred.appId,
          name: defaultCred.name,
          status: defaultCred.status,
          createdAt: defaultCred.createdAt,
          updatedAt: defaultCred.updatedAt,
          lastUsedAt: defaultCred.lastUsedAt,
          maskedSecret: this.maskSecret(defaultCred.appSecret),
        },
      ];
    }

    return list.map((item) => {
      let plainSecret: string | null = null;
      if (item.appSecretEnc) {
        plainSecret = decryptModelCredential(Buffer.from(item.appSecretEnc, 'utf8'));
      }
      return {
        id: item.id,
        appId: item.appId,
        name: item.name,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastUsedAt: item.lastUsedAt,
        maskedSecret: this.maskSecret(plainSecret),
      };
    });
  }

  async createDefaultCredential(userId: string): Promise<CreatedCredentialDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const prefix = user?.username ? `app_${user.username.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16)}_` : 'app_';
    const appId = `${prefix}${randomBytes(4).toString('hex')}`;
    return this.createCredential(userId, {
      appId,
      name: '默认服务凭证',
    });
  }

  async createCredential(
    userId: string,
    data: { appId?: string; name?: string },
  ): Promise<CreatedCredentialDto> {
    const appId = this.generateAppId(data.appId);

    const existing = await this.prisma.userCredential.findUnique({
      where: { appId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`appId '${appId}' 已存在，请使用其他 appId`);
    }

    const appSecret = this.generateAppSecret();
    const appSecretHash = this.hashSecret(appSecret);
    const appSecretEnc = encryptModelCredential(appSecret).toString('utf8');

    const created = await this.prisma.userCredential.create({
      data: {
        userId,
        appId,
        appSecretHash,
        appSecretEnc,
        name: data.name?.trim() || '外部系统调用',
        status: 'active',
      },
    });

    return {
      id: created.id,
      appId: created.appId,
      name: created.name,
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      lastUsedAt: created.lastUsedAt,
      maskedSecret: this.maskSecret(appSecret),
      appSecret,
      note: 'app_secret 仅此一次明文返回，请立即保存至密钥管理服务',
    };
  }

  async updateCredential(
    userId: string,
    id: string,
    data: { name?: string; status?: string; rotateSecret?: boolean },
  ): Promise<UserCredentialDto & { appSecret?: string }> {
    const credential = await this.prisma.userCredential.findFirst({
      where: { id, userId },
    });
    if (!credential) {
      throw new NotFoundException('未找到该凭证或无权限访问');
    }

    const updateData: any = {};
    if (typeof data.name === 'string') {
      updateData.name = data.name.trim();
    }
    if (data.status && ['active', 'disabled'].includes(data.status)) {
      updateData.status = data.status;
    }

    let newSecret: string | undefined;
    if (data.rotateSecret) {
      newSecret = this.generateAppSecret();
      updateData.appSecretHash = this.hashSecret(newSecret);
      updateData.appSecretEnc = encryptModelCredential(newSecret).toString('utf8');
    }

    const updated = await this.prisma.userCredential.update({
      where: { id },
      data: updateData,
    });

    let plainSecret = newSecret;
    if (!plainSecret && updated.appSecretEnc) {
      plainSecret = decryptModelCredential(Buffer.from(updated.appSecretEnc, 'utf8'));
    }

    return {
      id: updated.id,
      appId: updated.appId,
      name: updated.name,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      lastUsedAt: updated.lastUsedAt,
      maskedSecret: this.maskSecret(plainSecret),
      ...(newSecret ? { appSecret: newSecret } : {}),
    };
  }

  async deleteCredential(userId: string, id: string): Promise<{ success: boolean }> {
    const credential = await this.prisma.userCredential.findFirst({
      where: { id, userId },
    });
    if (!credential) {
      throw new NotFoundException('未找到该凭证或无权限操作');
    }
    await this.prisma.userCredential.delete({
      where: { id },
    });
    return { success: true };
  }

  async verifyCredential(appId: string, appSecret: string) {
    if (!appId || !appSecret) return null;
    const credential = await this.prisma.userCredential.findUnique({
      where: { appId },
      include: {
        user: {
          include: {
            roles: { include: { role: true } },
            orgs: { include: { orgNode: true } },
          },
        },
      },
    });

    if (!credential || credential.status !== 'active') return null;
    if (credential.user.status !== 'active') return null;

    const providedHash = this.hashSecret(appSecret.trim());
    if (providedHash !== credential.appSecretHash) {
      // Fallback check against decrypted secret in case of legacy hash
      if (credential.appSecretEnc) {
        const plain = decryptModelCredential(Buffer.from(credential.appSecretEnc, 'utf8'));
        if (plain !== appSecret.trim()) return null;
      } else {
        return null;
      }
    }

    // Update lastUsedAt asynchronously without blocking
    this.prisma.userCredential
      .update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return {
      credential: {
        id: credential.id,
        appId: credential.appId,
        name: credential.name,
      },
      user: {
        id: credential.user.id,
        username: credential.user.username,
        displayName: credential.user.displayName,
        email: credential.user.email,
        roles: credential.user.roles,
        orgs: credential.user.orgs,
      },
    };
  }
}
