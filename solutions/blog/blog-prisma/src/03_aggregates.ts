// ============================================================================
// 03 聚合：count / _count / aggregate / groupBy / having
// ----------------------------------------------------------------------------
// Prisma 的聚合 API 一开始有点反直觉，记住这条对照：
//   prisma.count()                   ← SELECT count(*)
//   include: { _count: { ... } }     ← LATERAL 子查询，每行带上"相关条数"
//   prisma.aggregate()               ← SELECT count, sum, avg, min, max ...
//   prisma.groupBy()                 ← SELECT col, agg(*) ... GROUP BY col
// ============================================================================

import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('3.1 count：最简单的统计')
  // --------------------------------------------------------------------------
  const publishedCount = await prisma.post.count({
    where: { status: 'published', deletedAt: null },
  })
  show('已发布文章数', publishedCount)

  // --------------------------------------------------------------------------
  section('3.2 _count：每个 user 的 posts / likes 数（关联 count）')
  // --------------------------------------------------------------------------
  // ★ 这是 Prisma 最甜的 API 之一——一次 SQL（LATERAL 子查询）出所有计数
  // 比手动 N+1 (for user of users: count posts where author=user) 快几个数量级
  const usersWithCounts = await prisma.user.findMany({
    where: { role: { in: ['author', 'admin'] } },
    select: {
      id: true,
      username: true,
      _count: {
        select: {
          posts: { where: { status: 'published', deletedAt: null } },
          likes: true,                                // 该用户点过的赞数
          comments: { where: { deletedAt: null } },
        },
      },
    },
  })
  show('用户 + 关联计数', usersWithCounts)

  // --------------------------------------------------------------------------
  section('3.3 aggregate：sum / avg / min / max')
  // --------------------------------------------------------------------------
  const stats = await prisma.post.aggregate({
    where: { status: 'published', deletedAt: null },
    _count: { _all: true },
    _sum: { viewCount: true, likeCount: true },
    _avg: { viewCount: true },
    _max: { viewCount: true },
    _min: { viewCount: true },
  })
  show('已发布文章统计', stats)

  // --------------------------------------------------------------------------
  section('3.4 groupBy：按 status 分组统计')
  // --------------------------------------------------------------------------
  const byStatus = await prisma.post.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: { _all: true },
    _avg: { viewCount: true },
    orderBy: { status: 'asc' },
  })
  show('各状态分布', byStatus)

  // --------------------------------------------------------------------------
  section('3.5 groupBy + having：只看"已发布数 > 2 的作者"')
  // --------------------------------------------------------------------------
  // ★ having 语法和 where 略不同，必须用 _count/_sum 等聚合形式
  const prolific = await prisma.post.groupBy({
    by: ['authorId'],
    where: { status: 'published', deletedAt: null },
    _count: { _all: true },
    having: {
      authorId: { _count: { gt: 2 } },
    },
    orderBy: { _count: { authorId: 'desc' } },
  })
  show('已发布数 > 2 的作者', prolific)

  // --------------------------------------------------------------------------
  section('3.6 取每个 user 的最新一篇文章（替代窗口函数的常见 hack）')
  // --------------------------------------------------------------------------
  // Prisma 没有内置窗口函数（5.x），但可以用 include + take + orderBy 模拟"每组取 N"
  const latestPerUser = await prisma.user.findMany({
    where: { role: { in: ['author', 'admin'] } },
    select: {
      username: true,
      posts: {
        where: { status: 'published', deletedAt: null },
        orderBy: { publishedAt: 'desc' },
        take: 1,                                      // ★ 每个 user 取一篇
        select: { title: true, publishedAt: true },
      },
    },
  })
  show('每作者最新一篇', latestPerUser)
  // ★ 注意：这其实是 LATERAL JOIN，一次 SQL 搞定。Prisma 5.x 默认行为
  // ★ 真要做"每组取 N" 且 N 较大，性能上窗口函数更优 — 落 $queryRaw

  console.log('\n✅ 03_aggregates 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
