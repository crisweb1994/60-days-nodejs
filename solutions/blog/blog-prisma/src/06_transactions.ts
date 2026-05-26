// ============================================================================
// 06 事务：sequential 数组 / interactive callback / 隔离级别 / 行锁 / 死锁
// ----------------------------------------------------------------------------
// 重点理解：
//   - 两套 API 的适用场景
//   - 隔离级别在并发下的实际表现
//   - 行锁防 lost update
//   - 死锁是必然发生的，要捕获并 retry
// ============================================================================

import { Prisma } from '@prisma/client'
import { prisma, section, show } from './prisma.js'

async function main() {
  // --------------------------------------------------------------------------
  section('6.1 sequential 数组：原子写入 like + notification')
  // --------------------------------------------------------------------------
  // 找一个能点的目标
  const post = await prisma.post.findUniqueOrThrow({ where: { slug: 'ts-utility-types' } })
  const tempUser = await prisma.user.create({
    data: {
      email: `tx-array-${Date.now()}@example.com`,
      username: `tx_array_${Date.now()}`,
      password: 'x',
      role: 'user',
    },
  })

  const [like, notif] = await prisma.$transaction([
    prisma.like.create({
      data: { userId: tempUser.id, postId: post.id },
    }),
    prisma.notification.create({
      data: {
        recipientId: post.authorId,
        type: 'post_liked',
        payload: { postId: post.id, postTitle: post.title, likerName: tempUser.username },
      },
    }),
  ])
  show('数组事务原子成功', { likeUser: like.userId, notifId: notif.id })

  // 清理
  await prisma.notification.delete({ where: { id: notif.id } })
  await prisma.like.delete({ where: { userId_postId: { userId: tempUser.id, postId: post.id } } })

  // --------------------------------------------------------------------------
  section('6.2 sequential 数组：第 2 条失败，第 1 条会回滚')
  // --------------------------------------------------------------------------
  // 故意让第 2 条违反 UNIQUE（重复用户名）
  try {
    await prisma.$transaction([
      prisma.user.create({
        data: {
          email: `tx-rollback-${Date.now()}@example.com`,
          username: `tx_rollback_unique_${Date.now()}`,
          password: 'x',
        },
      }),
      prisma.user.create({
        data: {
          email: 'duplicate@example.com',
          username: 'alice',                 // ★ 已存在，UNIQUE 冲突
          password: 'x',
        },
      }),
    ])
    show('❌ 不该到这', null)
  } catch (err) {
    show('第 2 条 unique 冲突 → 整批回滚', (err as Error).message.split('\n')[0])
  }

  // 验证第 1 条确实没插入（用 startsWith 找）
  const survivors = await prisma.user.count({ where: { username: { startsWith: 'tx_rollback_unique_' } } })
  show('第 1 条是否留存', survivors === 0 ? '✅ 已回滚' : '❌ 没回滚')

  // --------------------------------------------------------------------------
  section('6.3 interactive callback：中间要读再决定写什么')
  // --------------------------------------------------------------------------
  // 业务：如果文章 likeCount > 阈值，就不允许再点赞
  const result = await prisma.$transaction(async tx => {
    const p = await tx.post.findUniqueOrThrow({ where: { id: post.id } })
    if (p.likeCount > 10_000) {
      throw new Error('过热，禁止点赞')
    }
    // 假装做了点赞动作
    return { ok: true, currentLikeCount: p.likeCount }
  })
  show('callback 事务读后决定', result)

  // --------------------------------------------------------------------------
  section('6.4 callback throw → 自动 rollback')
  // --------------------------------------------------------------------------
  const beforeTags = await prisma.tag.count()
  try {
    await prisma.$transaction(async tx => {
      await tx.tag.create({ data: { name: `temp_${Date.now()}`, slug: `temp-${Date.now()}` } })
      throw new Error('intentional rollback')
    })
  } catch (err) {
    show('callback throw', (err as Error).message)
  }
  const afterTags = await prisma.tag.count()
  show('tag 数量', { before: beforeTags, after: afterTags, equal: beforeTags === afterTags })

  // --------------------------------------------------------------------------
  section('6.5 Serializable 隔离级别 + 并发冲突演示')
  // --------------------------------------------------------------------------
  // Serializable 在 RC/RR 之上加 SSI：发现可能破坏可串行化时主动抛 40001。
  // 构造场景：两个事务都 "count published → 自己再插一条 published"
  //   单独跑都对，但并发跑时一方会被 PG 杀掉。
  await prisma.post.update({
    where: { id: post.id },
    data: { viewCount: 0 },
  })

  const serializableTask = async (tag: string) => {
    return prisma.$transaction(
      async tx => {
        // 读：当前 published 数
        const before = await tx.post.count({ where: { status: 'published' } })
        // 故意 sleep 让两个事务的读发生交错
        await new Promise(r => setTimeout(r, 50))
        // 写：基于 before 写一条新数据（模拟"凑够 N 条就涨价"这种依赖统计的写）
        await tx.post.update({
          where: { id: post.id },
          data: { viewCount: before },
        })
        return `[${tag}] count=${before} ok`
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    )
  }

  const serResults = await Promise.allSettled([
    serializableTask('A'),
    serializableTask('B'),
  ])
  serResults.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      show(`Serializable tx ${i}`, s.value)
    } else {
      const code = (s.reason as any).code ?? (s.reason as any).meta?.code ?? 'unknown'
      // Prisma 把 PG 40001 (serialization_failure) / 40P01 (deadlock) 都包装成 P2034
      show(`Serializable tx ${i} 冲突`, `code=${code} (Prisma 对 PG 40001/40P01 的包装，业务层应 retry)`)
    }
  })
  // 还原
  await prisma.post.update({ where: { id: post.id }, data: { viewCount: 0 } })

  // --------------------------------------------------------------------------
  section('6.6 行锁防 lost update —— SELECT FOR UPDATE')
  // --------------------------------------------------------------------------
  // 模拟"读 - 算 - 写"，证明 FOR UPDATE 让两个事务串行而不是并行覆盖
  await prisma.post.update({
    where: { id: post.id },
    data: { viewCount: 0 },                                 // 重置成 0 便于观察
  })

  const concurrentUpdate = async (tag: string) => {
    return prisma.$transaction(async tx => {
      // ★ FOR UPDATE 在 PG 端锁住这一行，其他事务的 FOR UPDATE 要等
      await tx.$queryRaw`SELECT id FROM posts WHERE id = ${post.id}::uuid FOR UPDATE`
      const cur = await tx.post.findUniqueOrThrow({ where: { id: post.id } })
      // ⚠️ 故意 sleep 模拟业务计算耗时——本身是反模式（违反 README §14：事务里别 await 外部 Promise）
      //   生产代码请把"算"挪到事务外，只在事务里读 + 写。这里只是为了让锁竞争效果可见。
      await new Promise(r => setTimeout(r, 100))
      await tx.post.update({
        where: { id: post.id },
        data: { viewCount: cur.viewCount + 1 },
      })
      return `[${tag}] read=${cur.viewCount} → wrote=${cur.viewCount + 1}`
    })
  }

  const results = await Promise.all([
    concurrentUpdate('A'),
    concurrentUpdate('B'),
    concurrentUpdate('C'),
  ])
  results.forEach(r => show('并发结果', r))

  const final = await prisma.post.findUniqueOrThrow({ where: { id: post.id } })
  show('最终 viewCount', { expected: 3, actual: final.viewCount, ok: final.viewCount === 3 })
  // 还原
  await prisma.post.update({ where: { id: post.id }, data: { viewCount: 0 } })

  // --------------------------------------------------------------------------
  section('6.7 原子操作 vs 行锁：90% 场景用原子操作就够')
  // --------------------------------------------------------------------------
  // 同样的 +1 用 increment：完全不需要事务，且更快
  await Promise.all([
    prisma.post.update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } }),
    prisma.post.update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } }),
    prisma.post.update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } }),
  ])
  const after = await prisma.post.findUniqueOrThrow({ where: { id: post.id } })
  show('increment 并发结果', { actual: after.viewCount, ok: after.viewCount === 3 })
  // 还原
  await prisma.post.update({ where: { id: post.id }, data: { viewCount: 0 } })

  // --------------------------------------------------------------------------
  section('6.8 死锁演示 + retry')
  // --------------------------------------------------------------------------
  // 经典死锁：A 先锁 row1 再锁 row2；B 先锁 row2 再锁 row1
  // PG 检测到后会杀其中一个，抛错码 40P01
  const post1 = post
  const post2 = await prisma.post.findUniqueOrThrow({ where: { slug: 'nest-modules' } })

  const lockOrder = async (firstId: string, secondId: string, tag: string) => {
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM posts WHERE id = ${firstId}::uuid FOR UPDATE`
      await new Promise(r => setTimeout(r, 50))
      await tx.$queryRaw`SELECT id FROM posts WHERE id = ${secondId}::uuid FOR UPDATE`
      return `[${tag}] ok`
    })
  }

  const settled = await Promise.allSettled([
    lockOrder(post1.id, post2.id, 'A'),
    lockOrder(post2.id, post1.id, 'B'),
  ])
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      show(`tx ${i}`, s.value)
    } else {
      // ★ Prisma 错误 message 第一行经常是空行，取 meta.code / code 才稳
      const r = s.reason as any
      const code = r?.meta?.code ?? r?.code ?? 'unknown'
      const firstNonEmpty = String(r?.message ?? '').split('\n').find((l: string) => l.trim()) ?? '(empty)'
      show(`tx ${i} 死锁`, { code, hint: firstNonEmpty })
    }
  })

  // 清理临时用户
  await prisma.user.delete({ where: { id: tempUser.id } })

  console.log('\n✅ 06_transactions 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
