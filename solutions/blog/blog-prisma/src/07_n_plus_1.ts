// ============================================================================
// 07 N+1 问题：演示 + 三种修法 + SQL 计数对比
// ----------------------------------------------------------------------------
// 用 prisma 的 query log 数 SQL 条数，直观看 N+1 vs 修复版的差距。
// ============================================================================

import { PrismaClient } from '@prisma/client'
import { section, show } from './prisma.js'

// 不复用全局单例：要专门监听 query 事件
const prisma = new PrismaClient({
  log: [{ level: 'query', emit: 'event' }],
})

let sqlCount = 0
prisma.$on('query', () => {
  sqlCount++
})

function reset() { sqlCount = 0 }
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; sql: number }> {
  reset()
  const t0 = Date.now()
  const result = await fn()
  return { result, ms: Date.now() - t0, sql: sqlCount }
}

async function main() {
  // --------------------------------------------------------------------------
  section('7.1 ❌ N+1：先查所有 published，再循环查每个 author')
  // --------------------------------------------------------------------------
  const bad1 = await timed(async () => {
    const posts = await prisma.post.findMany({
      where: { status: 'published', deletedAt: null },
    })
    const results: Array<{ title: string; author: string }> = []
    for (const p of posts) {
      const author = await prisma.user.findUniqueOrThrow({ where: { id: p.authorId } })
      results.push({ title: p.title, author: author.username })
    }
    return results
  })
  show('N+1 写法', { posts: bad1.result.length, SQL: bad1.sql, ms: bad1.ms })

  // --------------------------------------------------------------------------
  section('7.2 ✅ 修法 A：include 关联 author')
  // --------------------------------------------------------------------------
  const good1 = await timed(async () => {
    const posts = await prisma.post.findMany({
      where: { status: 'published', deletedAt: null },
      include: { author: { select: { username: true } } },
    })
    return posts.map(p => ({ title: p.title, author: p.author.username }))
  })
  show('include 写法', { posts: good1.result.length, SQL: good1.sql, ms: good1.ms })

  // --------------------------------------------------------------------------
  section('7.3 ✅ 修法 B：select 精确取关联字段')
  // --------------------------------------------------------------------------
  const good2 = await timed(async () => {
    const posts = await prisma.post.findMany({
      where: { status: 'published', deletedAt: null },
      select: {
        title: true,
        author: { select: { username: true } },
      },
    })
    return posts.map(p => ({ title: p.title, author: p.author.username }))
  })
  show('select 写法', { posts: good2.result.length, SQL: good2.sql, ms: good2.ms })

  // --------------------------------------------------------------------------
  section('7.4 ✅ 修法 C：批量预加载（适合关联表巨大 / 复杂过滤）')
  // --------------------------------------------------------------------------
  const good3 = await timed(async () => {
    const posts = await prisma.post.findMany({
      where: { status: 'published', deletedAt: null },
    })
    const authorIds = [...new Set(posts.map(p => p.authorId))]
    const authors = await prisma.user.findMany({ where: { id: { in: authorIds } } })
    const authorMap = new Map(authors.map(a => [a.id, a.username]))
    return posts.map(p => ({ title: p.title, author: authorMap.get(p.authorId)! }))
  })
  show('批量预加载', { posts: good3.result.length, SQL: good3.sql, ms: good3.ms })

  // --------------------------------------------------------------------------
  section('7.5 ❌ 另一种 N+1：列表 + 循环 count')
  // --------------------------------------------------------------------------
  const bad2 = await timed(async () => {
    const users = await prisma.user.findMany({ where: { role: { in: ['author', 'admin'] } } })
    const out: Array<{ username: string; posts: number }> = []
    for (const u of users) {
      const cnt = await prisma.post.count({ where: { authorId: u.id, status: 'published' } })
      out.push({ username: u.username, posts: cnt })
    }
    return out
  })
  show('循环 count', { users: bad2.result.length, SQL: bad2.sql, ms: bad2.ms })

  // --------------------------------------------------------------------------
  section('7.6 ✅ 修法 D：_count 投影（LATERAL 子查询）')
  // --------------------------------------------------------------------------
  const good4 = await timed(async () => {
    return prisma.user.findMany({
      where: { role: { in: ['author', 'admin'] } },
      select: {
        username: true,
        _count: { select: { posts: { where: { status: 'published' } } } },
      },
    })
  })
  show('_count 投影', {
    users: good4.result.length,
    SQL: good4.sql,
    ms: good4.ms,
    sample: good4.result.slice(0, 2),
  })

  // --------------------------------------------------------------------------
  section('7.7 数量级总结')
  // --------------------------------------------------------------------------
  console.log(`
  ┌─────────────────────────┬───────┬──────────┐
  │ 场景                    │  SQL  │   耗时    │
  ├─────────────────────────┼───────┼──────────┤
  │ N+1 (循环 findUnique)   │   ${String(bad1.sql).padStart(3)} │  ${String(bad1.ms).padStart(4)} ms │
  │ include 关联            │   ${String(good1.sql).padStart(3)} │  ${String(good1.ms).padStart(4)} ms │
  │ select 关联             │   ${String(good2.sql).padStart(3)} │  ${String(good2.ms).padStart(4)} ms │
  │ 批量预加载              │   ${String(good3.sql).padStart(3)} │  ${String(good3.ms).padStart(4)} ms │
  │ N+1 (循环 count)        │   ${String(bad2.sql).padStart(3)} │  ${String(bad2.ms).padStart(4)} ms │
  │ _count 投影             │   ${String(good4.sql).padStart(3)} │  ${String(good4.ms).padStart(4)} ms │
  └─────────────────────────┴───────┴──────────┘
  ★ 本机小数据看不出极端差距；上 10w 行数据（blog-db --large）差距会数十倍
  `)

  console.log('\n✅ 07_n_plus_1 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
