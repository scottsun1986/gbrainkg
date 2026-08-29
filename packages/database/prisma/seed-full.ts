import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'node:crypto'

const prisma = new PrismaClient()

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
}

async function main() {
  console.log('Start full seeding ...')

  // Clear existing
  await prisma.knowledgeBase.deleteMany();
  await prisma.user.deleteMany();
  await prisma.orgNode.deleteMany();
  await prisma.role.deleteMany();

  // Create Users
  const u1 = await prisma.user.create({ data: { username: 'CY', email: 'cy@example.com', displayName: '陈昱', passwordHash: hashPassword(process.env.SEED_PASSWORD || 'LLMwiki@2026') }});
  const u2 = await prisma.user.create({ data: { username: 'LK', email: 'lk@example.com', displayName: '林珂' }});
  const u3 = await prisma.user.create({ data: { username: 'LH', email: 'lh@example.com', displayName: '李航' }});
  const u4 = await prisma.user.create({ data: { username: 'ZM', email: 'zm@example.com', displayName: '赵明' }});
  const u5 = await prisma.user.create({ data: { username: 'WY', email: 'wy@example.com', displayName: '吴悦' }});

  const adminRole = await prisma.role.create({ data: { name: '超级管理员', builtin: true, description: '验收环境管理员' } });
  await prisma.userRole.create({ data: { userId: u1.id, roleId: adminRole.id } });

  // Create Orgs
  const group = await prisma.orgNode.create({ data: { name: '集团总部', path: '/group' }});
  const compliance = await prisma.orgNode.create({ data: { name: '合规部', path: '/group/compliance', parentId: group.id }});
  const rd = await prisma.orgNode.create({ data: { name: '研发中心', path: '/group/rd', parentId: group.id }});
  const market = await prisma.orgNode.create({ data: { name: '市场部', path: '/group/market', parentId: group.id }});

  await prisma.userOrg.createMany({
    data: [
      { userId: u1.id, orgNodeId: compliance.id },
      { userId: u2.id, orgNodeId: compliance.id },
      { userId: u3.id, orgNodeId: rd.id },
      { userId: u4.id, orgNodeId: rd.id },
      { userId: u5.id, orgNodeId: market.id },
    ],
  });

  // Create Knowledge Bases
  const p1 = await prisma.knowledgeBase.create({
    data: { name: '陈昱 · 笔记', type: 'personal', ownerUserId: u1.id, gitRepoUrl: "dummy", description: '个人阅读笔记、合规学习记录、项目复盘' }
  });
  const p2 = await prisma.knowledgeBase.create({
    data: { name: '陈昱 · 法规摘录', type: 'personal', ownerUserId: u1.id, gitRepoUrl: "dummy", description: '日常关注法规条款摘录与标注' }
  });
  const o1 = await prisma.knowledgeBase.create({
    data: { name: '合规部知识库', type: 'org', orgNodeId: compliance.id, gitRepoUrl: "dummy", description: '部门制度、合规手册、审计报告、出境评估材料' }
  });
  const o2 = await prisma.knowledgeBase.create({
    data: { name: '研发中心知识库', type: 'org', orgNodeId: rd.id, gitRepoUrl: "dummy", description: '架构文档、技术规范、AI 平台设计' }
  });
  const o3 = await prisma.knowledgeBase.create({
    data: { name: '市场部知识库', type: 'org', orgNodeId: market.id, gitRepoUrl: "dummy", description: '品牌手册、活动方案、客户洞察' }
  });
  const i1 = await prisma.knowledgeBase.create({
    data: { name: '金融行业知识库', type: 'industry', gitRepoUrl: "dummy", description: '金融监管法规、跨境数据流动指引、行业最佳实践' }
  });
  const i2 = await prisma.knowledgeBase.create({
    data: { name: '医疗行业知识库', type: 'industry', gitRepoUrl: "dummy", description: '医疗数据合规、患者信息保护相关规范' }
  });

  // Link admins
  await prisma.kbAdmin.createMany({
    data: [
      { kbId: p1.id, userId: u1.id },
      { kbId: p2.id, userId: u1.id },
      { kbId: o1.id, userId: u2.id },
      { kbId: o1.id, userId: u1.id },
      { kbId: o2.id, userId: u3.id },
      { kbId: o2.id, userId: u4.id },
      { kbId: o3.id, userId: u5.id },
      { kbId: i1.id, userId: u2.id },
      { kbId: i2.id, userId: u2.id },
    ]
  });

  await prisma.industryGrant.create({
    data: { kbId: i1.id, subjectType: 'user', subjectId: u1.id, grantedById: u1.id },
  });

  await prisma.brainRepo.createMany({
    data: [u1, u2, u3, u4, u5].map((user) => ({
      userId: user.id,
      gitRepoUrl: `/tmp/llmwiki/brain_repos/brain-${user.id}`,
    })),
  });

  console.log('Seeding full finished.')
}

main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
