// ============================================================================
// 02 关联：include vs select / connect / connectOrCreate / 嵌套写入
// ----------------------------------------------------------------------------
// 重点理解：
//   - include 返回原对象 + 关联，select 只返回指定字段
//   - 创建带关联的对象时 connect / create / connectOrCreate 的语义差别
//   - PG 触发器在 Prisma 端的透传效果（likes -> posts.like_count）
// ============================================================================

import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('2.1 include：返回原对象 + 关联')
  // --------------------------------------------------------------------------
  const post = await prisma.post.findUnique({
    where: { slug: 'hello-postgres' },
    include: {
      author: true,
      tags: { include: { tag: true } },
    },
  })
  show('post + author + tags (include)', post)

  // --------------------------------------------------------------------------
  section('2.2 select：精确指定要哪些字段（生产推荐）')
  // --------------------------------------------------------------------------
  const lean = await prisma.post.findUnique({
    where: { slug: 'hello-postgres' },
    select: {
      id: true,
      title: true,
      author: { select: { username: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  })
  show('post (select 精确字段)', lean)
  // ★ lean.content ❌ 编译错——没 select 就不在类型里

  // --------------------------------------------------------------------------
  section('2.3 关联过滤：only-tags 含 nodejs 的文章')
  // --------------------------------------------------------------------------
  const taggedNodejs = await prisma.post.findMany({
    where: {
      status: 'published',
      tags: { some: { tag: { slug: 'node-js' } } },   // ★ some/every/none 三种谓词
    },
    select: { slug: true, title: true },
  })
  show('打了 Node.js 标签的 published 文章', taggedNodejs)

  // --------------------------------------------------------------------------
  section('2.4 connect：用已有的关联')
  // --------------------------------------------------------------------------
  // 给 alice 新建一篇文章，关联已有 tag = TypeScript
  const alice = await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } })
  const ts = await prisma.tag.findUniqueOrThrow({ where: { slug: 'typescript' } })

  const newPost = await prisma.post.create({
    data: {
      slug: `demo-${Date.now()}`,
      title: 'Prisma demo 临时文章',
      content: 'temporary',
      status: 'draft',                                  // draft 不需要 publishedAt
      author: { connect: { id: alice.id } },           // ★ connect 现有 user
      tags: {
        create: [
          { tag: { connect: { id: ts.id } } },          // ★ post_tags 中间表 + connect tag
        ],
      },
    },
    include: { tags: { include: { tag: true } } },
  })
  show('新建 post + 关联 TS tag', {
    id: newPost.id,
    tagsCount: newPost.tags.length,
    tagName: newPost.tags[0].tag.name,
  })

  // 清理
  await prisma.post.delete({ where: { id: newPost.id } })

  // --------------------------------------------------------------------------
  section('2.5 connectOrCreate：标签不存在就建')
  // --------------------------------------------------------------------------
  // 真实业务里"创建文章 + 用户输入标签字符串"——有就关联、没有就建
  const userInputTagSlugs = ['typescript', 'newtag-' + Date.now()]
  const newPost2 = await prisma.post.create({
    data: {
      slug: `demo-coc-${Date.now()}`,
      title: 'connectOrCreate demo',
      content: 'x',
      status: 'draft',
      author: { connect: { id: alice.id } },
      tags: {
        create: userInputTagSlugs.map(slug => ({
          tag: {
            connectOrCreate: {
              where: { slug },
              create: { name: slug, slug },             // 兜底名字 = slug
            },
          },
        })),
      },
    },
    include: { tags: { include: { tag: true } } },
  })
  show('connectOrCreate 之后的 tags', newPost2.tags.map(pt => pt.tag.slug))
  // 清理
  await prisma.post.delete({ where: { id: newPost2.id } })
  await prisma.tag.deleteMany({ where: { slug: { startsWith: 'newtag-' } } })

  // --------------------------------------------------------------------------
  section('2.6 ★ PG 触发器透传：Prisma 创建 like 后 posts.like_count 自动 +1')
  // --------------------------------------------------------------------------
  const helloPost = await prisma.post.findUniqueOrThrow({ where: { slug: 'hello-postgres' } })
  const beforeCount = helloPost.likeCount

  // 找一个还没点过赞的用户（admin 已点，bob 已点；alice 是作者自己。新建一个临时用户）
  const tempUser = await prisma.user.create({
    data: {
      email: `liker-${Date.now()}@example.com`,
      username: `liker_${Date.now()}`,
      password: 'x',
      role: 'user',
    },
  })

  await prisma.like.create({
    data: {
      user: { connect: { id: tempUser.id } },
      post: { connect: { id: helloPost.id } },
    },
  })

  // 立刻再查一次 post：触发器同步在事务内，应能看到 +1
  const afterFetch = await prisma.post.findUniqueOrThrow({
    where: { id: helloPost.id },
    select: { likeCount: true },
  })
  show('like_count 变化', {
    before: beforeCount,
    after: afterFetch.likeCount,
    delta: afterFetch.likeCount - beforeCount,
  })

  // 撤销点赞，触发器 -1
  await prisma.like.delete({
    where: { userId_postId: { userId: tempUser.id, postId: helloPost.id } },
  })
  const afterUnlike = await prisma.post.findUniqueOrThrow({
    where: { id: helloPost.id },
    select: { likeCount: true },
  })
  show('unlike 后 like_count', {
    final: afterUnlike.likeCount,
    回到原值: afterUnlike.likeCount === beforeCount,
  })

  // 清理临时用户
  await prisma.user.delete({ where: { id: tempUser.id } })

  // --------------------------------------------------------------------------
  section('2.7 自引用：评论树的 include 嵌套')
  // --------------------------------------------------------------------------
  // 只能 include 固定层数，递归不行——任意深度要落 $queryRaw（见 04_raw.ts）
  const topComments = await prisma.comment.findMany({
    where: {
      post: { slug: 'hello-postgres' },
      parentId: null,
      deletedAt: null,
    },
    include: {
      author: { select: { username: true } },
      replies: {                                        // 1 层回复
        where: { deletedAt: null },
        include: {
          author: { select: { username: true } },
          replies: {                                    // 2 层回复
            where: { deletedAt: null },
            include: { author: { select: { username: true } } },
          },
        },
      },
    },
  })
  show('顶层评论 + 2 层回复', topComments.map(c => ({
    author: c.author.username,
    content: c.content,
    replies: c.replies.map(r => ({
      author: r.author.username,
      content: r.content,
      sub: r.replies.map(s => `${s.author.username}: ${s.content}`),
    })),
  })))

  console.log('\n✅ 02_relations 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
