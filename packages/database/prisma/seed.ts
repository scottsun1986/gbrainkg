import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Start seeding ...')

  // 1. 创建用户
  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice (Admin)',
    },
  })

  // 2. 创建组织节点
  const devOrg = await prisma.orgNode.create({
    data: {
      name: 'R&D Department',
      path: '/rd',
    },
  })

  // 3. 用户关联组织
  await prisma.userOrg.create({
    data: {
      userId: alice.id,
      orgNodeId: devOrg.id,
    }
  })

  // 4. 创建个人大脑 Repo
  const brainRepo = await prisma.brainRepo.create({
    data: {
      userId: alice.id,
      gitRepoUrl: '/tmp/llmwiki/brain_repos/alice-brain',
    }
  })

  // 5. 创建主题和关联
  await prisma.brainTopic.create({
    data: {
      brainRepoId: brainRepo.id,
      topicSlug: '数据合规',
      mdPath: '数据合规.md',
      compileStatus: 'dirty', // 初始状态设为 dirty 方便测试懒编译
    }
  })

  console.log('Seeding finished.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
