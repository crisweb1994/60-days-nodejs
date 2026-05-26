// ============================================================================
// 01 基础 CRUD：findUnique / findMany / create / update / delete / upsert
// ----------------------------------------------------------------------------
// 跑之前确保 blog-db 已 migrate + seed。
// 每段操作之间无依赖，可以注释掉单看效果。
// ============================================================================

import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('1.1 findUnique：按 unique 字段查单条')
  // --------------------------------------------------------------------------
  // findUnique 只接受 @unique / @id 字段，能走 SQL 层 unique 索引
  // 查不到返回 null（不抛错）
  const alice = await prisma.user.findUnique({
    where: { username: 'alice' },
  })
  show('alice (full row)', alice)

  // --------------------------------------------------------------------------
  section('1.2 findUniqueOrThrow：找不到就抛')
  // --------------------------------------------------------------------------
  // 业务上必然存在的关键路径（按 id 查用户）用这个，省一段 if (!user) throw
  try {
    await prisma.user.findUniqueOrThrow({ where: { username: 'ghost' } })
  } catch (err) {
    show('ghost 不存在，抛出', (err as Error).message.split('\n')[0])
  }

  // --------------------------------------------------------------------------
  section('1.3 findMany + where + orderBy + take + skip')
  // --------------------------------------------------------------------------
  const recentPublished = await prisma.post.findMany({
    where: {
      status: 'published',
      deletedAt: null,             // ★ 软删过滤永远显式写，Prisma 不会自动加
    },
    orderBy: { publishedAt: 'desc' },
    take: 3,
    skip: 0,
    select: {
      id: true,
      slug: true,
      title: true,
      publishedAt: true,
    },
  })
  show('最近 3 篇已发布', recentPublished)

  // --------------------------------------------------------------------------
  section('1.4 复杂 where：AND / OR / NOT / 范围 / IN')
  // --------------------------------------------------------------------------
  const filtered = await prisma.post.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: 'published', viewCount: { gte: 100 } },
        { status: 'archived' },
      ],
      NOT: { slug: { contains: 'old' } },
    },
    select: { slug: true, status: true, viewCount: true },
    orderBy: { viewCount: 'desc' },
  })
  show('已发布且热度 ≥ 100，或归档；排除 slug 含 old', filtered)

  // --------------------------------------------------------------------------
  section('1.5 create：插入单条 + 默认值')
  // --------------------------------------------------------------------------
  // 用一个不会冲突的 slug；多次跑可能 unique 报错，用 try 包一下
  try {
    const created = await prisma.user.create({
      data: {
        email: `tester+${Date.now()}@example.com`,
        username: `tester_${Date.now()}`,
        password: '$2b$10$fake.hash',
        // role 用 default 'user'，createdAt/updatedAt 用 default now()
      },
    })
    show('新建 user', { id: created.id, role: created.role })
    // 清理掉演示账号
    await prisma.user.delete({ where: { id: created.id } })
  } catch (err) {
    show('create 失败（可能 unique 冲突）', (err as Error).message.split('\n')[0])
  }

  // --------------------------------------------------------------------------
  section('1.6 update + 原子操作：viewCount + 1')
  // --------------------------------------------------------------------------
  // ★ { increment: 1 } 翻译成 SQL: SET view_count = view_count + 1
  //   避免 "读-改-写" 竞态，永远优先用原子操作
  const post = await prisma.post.findFirst({ where: { status: 'published' } })
  if (post) {
    const before = post.viewCount
    const after = await prisma.post.update({
      where: { id: post.id },
      data: { viewCount: { increment: 1 } },
      select: { id: true, viewCount: true },
    })
    show('viewCount before/after', { before, after: after.viewCount })

    // 还原，免得 demo 反复跑数据漂
    await prisma.post.update({
      where: { id: post.id },
      data: { viewCount: { decrement: 1 } },
    })
  }

  // --------------------------------------------------------------------------
  section('1.7 upsert：有则更新，无则插入')
  // --------------------------------------------------------------------------
  // 经典场景：根据外部 ID 同步用户。slug 是 unique，我们用它做幂等键
  const upserted = await prisma.tag.upsert({
    where: { slug: 'rust' },
    create: { name: 'Rust', slug: 'rust', description: 'Rust 编程语言' },
    update: { description: 'Rust 编程语言（已更新）' },
  })
  show('upsert tag (第一次创建，第二次更新)', upserted)

  // --------------------------------------------------------------------------
  section('1.8 deleteMany：按条件批删')
  // --------------------------------------------------------------------------
  // 清掉刚 upsert 出来的 'rust' tag，恢复初始状态
  const deleted = await prisma.tag.deleteMany({ where: { slug: 'rust' } })
  show('deleteMany count', deleted)

  // --------------------------------------------------------------------------
  section('1.9 类型推断：select 决定返回类型')
  // --------------------------------------------------------------------------
  // ★ 鼠标悬停 selectedOnly 看类型：只有 id 和 title 两个属性
  const selectedOnly = await prisma.post.findFirst({
    select: { id: true, title: true },
  })
  show('selected only', selectedOnly)
  // selectedOnly.viewCount  ❌ 编译错——类型里没这个属性

  console.log('\n✅ 01_basics 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
