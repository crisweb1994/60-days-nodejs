// ============================================================================
// 04 原生 SQL 逃生口：$queryRaw / $executeRaw / 类型化
// ----------------------------------------------------------------------------
// 什么时候必须落 raw：
//   - 递归 CTE（评论树）
//   - 窗口函数
//   - JSONB @> 操作符
//   - INSERT ON CONFLICT 的复杂分支
//   - 按子查询聚合值排序
// 铁律：永远用模板字符串 $queryRaw`...`，让 Prisma 做参数化
// ============================================================================

import { Prisma } from '@prisma/client'
import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('4.1 $queryRaw 基础 + 类型注解')
  // --------------------------------------------------------------------------
  // ★ 泛型告诉 TS 返回结构；运行时 Prisma 不会校验，只是骗 TS
  const rows = await prisma.$queryRaw<Array<{ id: string; title: string; cnt: bigint }>>`
    SELECT p.id, p.title, count(l.user_id) AS cnt
    FROM posts p
    LEFT JOIN likes l ON l.post_id = p.id
    WHERE p.status = 'published'
    GROUP BY p.id, p.title
    ORDER BY cnt DESC
    LIMIT 3
  `
  // ★ count 返回 bigint，JSON 序列化要 patch（已在 prisma.ts 里加 toJSON）
  show('top 3 most-liked posts', rows.map(r => ({ ...r, cnt: Number(r.cnt) })))

  // --------------------------------------------------------------------------
  section('4.2 参数化：模板字符串自动绑参')
  // --------------------------------------------------------------------------
  // ★ ${status} 是被参数化的，不是字符串拼接，没注入风险
  const status = 'published'
  const minViews = 100
  const filtered = await prisma.$queryRaw<Array<{ slug: string; view_count: number }>>`
    SELECT slug, view_count
    FROM posts
    WHERE status = ${status} AND view_count >= ${minViews}
    ORDER BY view_count DESC
  `
  show('高阅读量 published', filtered)

  // --------------------------------------------------------------------------
  section('4.3 显式类型转换：UUID 列必须 ::uuid')
  // --------------------------------------------------------------------------
  // 如果 ${id} 不加 ::uuid，PG 会拿 text 比 uuid，要么报错要么走不到索引
  const helloPost = await prisma.post.findUniqueOrThrow({ where: { slug: 'hello-postgres' } })
  const single = await prisma.$queryRaw<Array<{ slug: string }>>`
    SELECT slug FROM posts WHERE id = ${helloPost.id}::uuid
  `
  show('显式 ::uuid', single)

  // --------------------------------------------------------------------------
  section('4.4 递归 CTE：评论树（Prisma 表达不出）')
  // --------------------------------------------------------------------------
  const postId = helloPost.id
  const tree = await prisma.$queryRaw<Array<{
    id: string
    parent_id: string | null
    content: string
    depth: number
  }>>`
    WITH RECURSIVE t AS (
      SELECT id, parent_id, content, 0 AS depth, created_at
      FROM comments
      WHERE post_id = ${postId}::uuid AND parent_id IS NULL AND deleted_at IS NULL
      UNION ALL
      SELECT c.id, c.parent_id, c.content, t.depth + 1, c.created_at
      FROM comments c
      INNER JOIN t ON c.parent_id = t.id
      WHERE c.post_id = ${postId}::uuid AND c.deleted_at IS NULL
    )
    SELECT id, parent_id, content, depth FROM t
    ORDER BY depth, created_at
  `
  show('评论树（depth 缩进展示）', tree.map(c =>
    `${'  '.repeat(c.depth)}└─ ${c.content}`,
  ))

  // --------------------------------------------------------------------------
  section('4.5 JSONB @> 包含查询（Prisma 5.x 也表达不全）')
  // --------------------------------------------------------------------------
  const withCover = await prisma.$queryRaw<Array<{ slug: string }>>`
    SELECT slug FROM posts
    WHERE metadata @> '{"cover_url": "/img/pg.png"}'::jsonb
  `
  show('封面图匹配的文章', withCover)

  // --------------------------------------------------------------------------
  section('4.6 $executeRaw：INSERT/UPDATE/DELETE 返回 affected rows')
  // --------------------------------------------------------------------------
  // 假设业务要"批量给所有 draft 文章浏览数 +1"——纯展示用法，跑完回滚
  await prisma.$transaction(async tx => {
    const affected = await tx.$executeRaw`
      UPDATE posts SET view_count = view_count + 1 WHERE status = 'draft'
    `
    show('UPDATE 影响行数', affected)
    // 回滚
    throw new Error('intentional rollback for demo')
  }).catch(err => {
    if ((err as Error).message !== 'intentional rollback for demo') throw err
    show('已 rollback', '数据未变')
  })

  // --------------------------------------------------------------------------
  section('4.7 Prisma.sql 拼接：分支 SQL 不破坏参数化')
  // --------------------------------------------------------------------------
  // ★ 想动态决定 ORDER BY 方向？用 Prisma.sql 模板拼接，别用 raw string +
  const orderDirection: 'ASC' | 'DESC' = 'DESC'
  const orderBy = orderDirection === 'DESC' ? Prisma.sql`DESC` : Prisma.sql`ASC`

  const dynamic = await prisma.$queryRaw<Array<{ slug: string; view_count: number }>>`
    SELECT slug, view_count
    FROM posts
    WHERE status = ${status}
    ORDER BY view_count ${orderBy}
    LIMIT 3
  `
  show('动态 ORDER BY 方向', dynamic)

  // --------------------------------------------------------------------------
  section('4.8 ❌ $queryRawUnsafe：永远不要用')
  // --------------------------------------------------------------------------
  // 演示用，不真跑——把用户输入拼进 SQL 是经典注入漏洞
  console.log(`
  ★ 反面教材（不要这么写）：
    const userInput = req.query.slug  // 假设是 "x' OR 1=1; --"
    prisma.$queryRawUnsafe(\`SELECT * FROM posts WHERE slug = '\${userInput}'\`)

  ★ 正确：永远 $queryRaw 模板字符串
    prisma.$queryRaw\`SELECT * FROM posts WHERE slug = \${userInput}\`
  `)

  console.log('\n✅ 04_raw 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
