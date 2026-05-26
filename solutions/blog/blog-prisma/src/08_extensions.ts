// ============================================================================
// 08 Client Extensions：model / query / result / client 四类
// ----------------------------------------------------------------------------
// 重点理解：
//   - extension 返回新 client，不修改原 client
//   - query 扩展能"透明"加 where（如软删过滤）
//   - result 扩展能加 computed field
//   - 软删扩展的局限：findUnique 要绕开、include 嵌套不会自动加
// ============================================================================

import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('8.1 model 扩展：给 post 加自定义方法 findPublished')
  // --------------------------------------------------------------------------
  const extModel = prisma.$extends({
    model: {
      post: {
        async findPublished(this: any, take = 5) {
          return this.findMany({
            where: { status: 'published', deletedAt: null },
            orderBy: { publishedAt: 'desc' },
            take,
            select: { slug: true, title: true, publishedAt: true },
          })
        },
      },
    },
  })

  const published = await extModel.post.findPublished(3)
  show('extModel.post.findPublished(3)', published)

  // --------------------------------------------------------------------------
  section('8.2 result 扩展：加 computed isPublic 字段')
  // --------------------------------------------------------------------------
  const extResult = prisma.$extends({
    result: {
      post: {
        isPublic: {
          needs: { status: true, deletedAt: true },         // 声明依赖的真实字段
          compute(post) {
            return post.status === 'published' && post.deletedAt === null
          },
        },
      },
    },
  })

  const helloPost = await extResult.post.findUnique({ where: { slug: 'hello-postgres' } })
  show('helloPost.isPublic', { isPublic: helloPost?.isPublic, status: helloPost?.status })

  // --------------------------------------------------------------------------
  section('8.3 client 扩展：加 $health 方法')
  // --------------------------------------------------------------------------
  const extClient = prisma.$extends({
    client: {
      async $health() {
        try {
          await (this as any).$queryRaw`SELECT 1`
          return 'ok'
        } catch {
          return 'down'
        }
      },
    },
  })
  show('extClient.$health()', await extClient.$health())

  // --------------------------------------------------------------------------
  section('8.4 query 扩展：劫持 findMany 自动加 deletedAt: null')
  // --------------------------------------------------------------------------
  // 软删的简化版扩展：只处理 post 的 findMany / findFirst
  const extSoftDelete = prisma.$extends({
    query: {
      post: {
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: null }
          return query(args)
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: null }
          return query(args)
        },
      },
    },
  })

  // 准备：先把 hello-postgres 软删
  await prisma.post.update({
    where: { slug: 'hello-postgres' },
    data: { deletedAt: new Date() },
  })

  // 用原 prisma 找：能看到（包括 deleted）
  const rawList = await prisma.post.findMany({
    where: { slug: 'hello-postgres' },
    select: { slug: true, deletedAt: true },
  })
  show('原 prisma 看 hello-postgres（含已删）', rawList)

  // 用扩展 client 找：自动过滤掉
  const filteredList = await extSoftDelete.post.findMany({
    where: { slug: 'hello-postgres' },
    select: { slug: true },
  })
  show('softDelete client 看（已过滤）', filteredList)

  // 还原
  await prisma.post.update({
    where: { slug: 'hello-postgres' },
    data: { deletedAt: null },
  })

  // --------------------------------------------------------------------------
  section('8.5 软删扩展的局限：findUnique 绕不开')
  // --------------------------------------------------------------------------
  console.log(`
  ★ findUnique 的 where 必须严格是 unique 字段（id / slug 等），
    塞入 deletedAt 会让查询失效。常见处理方式：
      a) extension 里把 findUnique 转成 findFirst（行为差异：会扫多一点）
      b) 应用层 if (post?.deletedAt) return null 显式检查
      c) DB 端做 partial unique index：UNIQUE (slug) WHERE deleted_at IS NULL
         —— 物理上保证软删和未删的 slug 不冲突
  `)

  // --------------------------------------------------------------------------
  section('8.6 多个 extension 组合：链式 $extends')
  // --------------------------------------------------------------------------
  const composed = prisma
    .$extends({
      model: {
        post: {
          async findPublishedSlugs(this: any) {
            const rows = await this.findMany({
              where: { status: 'published', deletedAt: null },
              select: { slug: true },
            })
            return rows.map((r: any) => r.slug)
          },
        },
      },
    })
    .$extends({
      client: {
        async $sayHi() {
          return 'hi from composed client'
        },
      },
    })

  show('composed.post.findPublishedSlugs', await composed.post.findPublishedSlugs())
  show('composed.$sayHi', await composed.$sayHi())

  // --------------------------------------------------------------------------
  section('8.7 ★ 关键观察：extension 返回新 client，不污染原 prisma')
  // --------------------------------------------------------------------------
  console.log('  原 prisma 没有 $health 方法:',
              (prisma as any).$health === undefined ? '✅ 是' : '❌ 否')
  console.log('  extClient 上才有:',
              typeof extClient.$health === 'function' ? '✅ 是' : '❌ 否')
  console.log(`
  ★ 这意味着：要么全代码用扩展 client，要么 export 单例时就用扩展版。
    最常见做法：在 prisma.ts 里 export const prisma = basePrisma.$extends({...})
    然后业务代码全部 import 这个增强后的 prisma。
  `)

  console.log('\n✅ 08_extensions 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
