// ============================================================================
// 05 真实业务查询：把 Day 22~24 写过的几条 SQL 用 Prisma 重新表达
// ----------------------------------------------------------------------------
// 重点是判断"哪些 Prisma 能做、哪些必须落 raw"。
// 末尾有加分题答案。
// ============================================================================

import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('5.1 文章列表页：基础字段 + 作者 + 标签数组 + 分页')
  // --------------------------------------------------------------------------
  // Day 22 的 array_agg 写法 → Prisma 用 select 嵌套
  const list = await prisma.post.findMany({
    where: { status: 'published', deletedAt: null },
    orderBy: { publishedAt: 'desc' },
    take: 10,
    skip: 0,
    select: {
      id: true,
      slug: true,
      title: true,
      publishedAt: true,
      likeCount: true,
      author: { select: { username: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  })

  // 把 [{tag: {name: 'X'}}, ...] 拍平成 ['X', ...]，前端直出
  const shaped = list.map(p => ({
    ...p,
    author: p.author.username,
    tags: p.tags.map(pt => pt.tag.name),
  }))
  show('列表页前 3 条', shaped.slice(0, 3))

  // --------------------------------------------------------------------------
  section('5.2 作者详情：基本信息 + 计数 + 最近 5 篇')
  // --------------------------------------------------------------------------
  const alice = await prisma.user.findUnique({
    where: { username: 'alice' },
    select: {
      id: true,
      username: true,
      _count: {
        select: {
          posts: { where: { status: 'published', deletedAt: null } },
        },
      },
      posts: {
        where: { status: 'published', deletedAt: null },
        orderBy: { publishedAt: 'desc' },
        take: 5,
        select: { slug: true, title: true, likeCount: true, publishedAt: true },
      },
    },
  })
  show('alice 作者主页', alice)

  // --------------------------------------------------------------------------
  section('5.3 标签云：每个标签 + 文章数（含 0）')
  // --------------------------------------------------------------------------
  const tagCloud = await prisma.tag.findMany({
    select: {
      name: true,
      slug: true,
      _count: {
        select: {
          posts: { where: { post: { status: 'published', deletedAt: null } } },
        },
      },
    },
    orderBy: { name: 'asc' },
  })
  show('标签云', tagCloud.map(t => ({ name: t.name, posts: t._count.posts })))

  // --------------------------------------------------------------------------
  section('5.4 ★ Prisma 边界：按子查询聚合值排序 —— 必须落 raw')
  // --------------------------------------------------------------------------
  // 需求：每作者按"已发布文章累计阅读数"降序
  // Prisma findMany.orderBy 不支持"按嵌套 _count/_sum 排序"（至少 5.x）
  // 所以走 $queryRaw
  type AuthorRanking = { username: string; total_views: bigint; post_count: bigint }
  const ranking = await prisma.$queryRaw<AuthorRanking[]>`
    SELECT
      u.username,
      coalesce(sum(p.view_count), 0) AS total_views,
      count(p.id)                    AS post_count
    FROM users u
    LEFT JOIN posts p ON p.author_id = u.id
                     AND p.status = 'published'
                     AND p.deleted_at IS NULL
    WHERE u.role IN ('author', 'admin')
    GROUP BY u.id, u.username
    ORDER BY total_views DESC
  `
  show('作者按累计阅读排名', ranking.map(r => ({
    username: r.username,
    total_views: Number(r.total_views),
    post_count: Number(r.post_count),
  })))

  // --------------------------------------------------------------------------
  section('5.5 ★ Prisma 边界：评论树（递归 CTE）—— 必须落 raw')
  // --------------------------------------------------------------------------
  // 已在 04_raw.ts §4.4 演示，这里只点明业务上 service 层应该封一个 helper
  console.log(`
  ★ 评论树是 Prisma 完全表达不出的场景，原因：
    - findMany 的 include 嵌套层数固定
    - 评论嵌套深度未知
    - 必须用 WITH RECURSIVE
  ★ 实战建议：把"取一篇文章的完整评论树"封装成 service 方法，
     内部用 prisma.$queryRaw + 类型定义，对上层暴露干净的 API
  `)

  // --------------------------------------------------------------------------
  section('5.6 检测 like_count 漂移（业务巡检任务）')
  // --------------------------------------------------------------------------
  // PG 端有 v_like_count_drift 视图，Prisma 直接调
  type Drift = { id: string; title: string; cached: number; actual: bigint; drift: bigint }
  const drift = await prisma.$queryRaw<Drift[]>`SELECT * FROM v_like_count_drift`
  show('计数漂移行（应该是 0 行）', drift.length === 0 ? '✅ 无漂移' : drift)

  console.log('\n✅ 05_real_queries 全部跑完\n')

  // ==========================================================================
  // 加分题答案
  // ==========================================================================
  /*
  1. CHECK 约束 posts_published_requires_timestamp 还在 PG 端。
     prisma.post.create({ data: { status: 'published' } }) 不带 publishedAt
     会被 PG 抛错：violates check constraint "posts_published_requires_timestamp"。
     Prisma 透传这个错误，对 Prisma 来说就是个 PrismaClientKnownRequestError(P2010)。
     业务层应该在 service 里要么应用层校验，要么传 publishedAt: new Date()。

  2. { viewCount: { increment: 1 } } 生成的 SQL 是：
       UPDATE "posts" SET "view_count" = "view_count" + 1 WHERE id = $1
     一条原子语句，无竞态。
     而 { viewCount: post.viewCount + 1 } 生成的 SQL：
       UPDATE "posts" SET "view_count" = 5 WHERE id = $1
     这是"读 + 算 + 写"分两步，两个并发请求会丢更新（lost update）。
     永远用 increment/decrement。

  3. include 和 select 在多数情况下生成的 SQL 一样，都是 JOIN 或 LATERAL。
     区别：
     - include: 返回原对象所有字段 + 关联（合并到结果里）
     - select:  只返回明确指定的字段，类型也只有这些
     生产用 select，临时调试用 include。
     Prisma 5.x 引入 relationLoadStrategy，可以强制选 join 或 query 策略。

  4. $queryRaw\`SELECT count(*) FROM posts\` 返回 bigint。
     原因：PG 的 count(*) 返回 bigint（虽然 INT 装得下），Prisma 不会主动 cast。
     JSON.stringify 会抛 TypeError。
     处理：Number(value) 转，或在 client 启动时 monkey-patch BigInt.prototype.toJSON
     （prisma.ts 里已经 patch）。

  5. PG 端漂移检测见 §5.6 的 v_like_count_drift 视图。
     修复 SQL（也可以 prisma.$executeRaw 跑）：
       UPDATE posts p SET like_count = sub.cnt
       FROM (SELECT post_id, count(*) AS cnt FROM likes GROUP BY post_id) sub
       WHERE p.id = sub.post_id AND p.like_count <> sub.cnt;
     生产建议每周跑一次定时任务。
  */
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
