import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { DEFAULT_ROLES } from '../permission/permissions';

const prisma = new PrismaClient();

function readRequiredSecret(): string {
  const file = process.env.ADMIN_INITIAL_PASSWORD_FILE;
  const fromFile = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const password = fromFile || String(process.env.ADMIN_INITIAL_PASSWORD || '').trim();
  if (!password) {
    throw new Error('ADMIN_INITIAL_PASSWORD_FILE or ADMIN_INITIAL_PASSWORD is required for the first production bootstrap.');
  }
  if (password.length < 12) {
    throw new Error('The initial admin password must contain at least 12 characters.');
  }
  return password;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function main() {
  const initialPassword = readRequiredSecret();

  for (const role of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
        builtin: role.builtin,
        permissions: role.permissions,
      },
      create: {
        name: role.name,
        description: role.description,
        builtin: role.builtin,
        permissions: role.permissions,
      },
    });
  }

  const existing = await prisma.user.findUnique({ where: { username: 'admin' } });
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      displayName: existing?.displayName || '超级管理员',
      status: 'active',
      ...(existing?.passwordHash ? {} : { passwordHash: hashPassword(initialPassword), mustChangePassword: true }),
    },
    create: {
      username: 'admin',
      displayName: '超级管理员',
      email: process.env.ADMIN_EMAIL || 'admin@local.invalid',
      passwordHash: hashPassword(initialPassword),
      mustChangePassword: true,
      status: 'active',
      source: 'manual',
    },
  });

  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: '超级管理员' } });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superAdmin.id } },
    update: {},
    create: { userId: admin.id, roleId: superAdmin.id },
  });

  console.log(JSON.stringify({ ok: true, username: admin.username, created: !existing, mustChangePassword: admin.mustChangePassword }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
