// ============================================================================
// 09 性能：createMany vs transaction 数组 / 连接池观察 / 慢查询日志
// ----------------------------------------------------------------------------
// 这个 demo 会插入 + 删除一批临时数据，跑完不留痕。
// 在 blog-db 小数据上耗时差距已经可见；上 --large 数据集差距更明显。
// ============================================================================

import { PrismaClient } from '@prisma/client'
import { section, show } from './prisma.js'

const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'warn',  emit: 'stdout' },
    { level: 'error', emit: 'stdout' },
  ],
})

let slowCount = 0
prisma.$on('query', e => {
  if (e.duration > 50) {
    slowCount++
    if (slowCount <= 3) {
      console.warn(`  ⚠️ SLOW QUERY (${e.duration}ms):`, e.query.slice(0, 100), '...')
    }
  }
})

async function main() {
  // --------------------------------------------------------------------------
  section('9.1 createMany vs $transaction 数组 vs 循环 create')
  // --------------------------------------------------------------------------
  const alice = await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } })
  const ROWS = 500
  const stamp = Date.now()

  const data = (offset: number) =>
    Array.from({ length: ROWS }, (_, i) => ({
      authorId: alice.id,
      slug:     `perf-${stamp}-${offset}-${i}`,
      title:    `perf test ${offset}-${i}`,
      content:  'x',
      status:   'draft',
    }))

  // 方式 A：createMany（一条 INSERT 多 VALUES）
  const tA0 = Date.now()
  const aResult = await prisma.post.createMany({ data: data(0), skipDuplicates: true })
  const tA = Date.now() - tA0

  // 方式 B：$transaction 数组（多条 INSERT 全部原子）
  const tB0 = Date.now()
  await prisma.$transaction(data(1).map(d => prisma.post.create({ data: d })))
  const tB = Date.now() - tB0

  // 方式 C：循环 await create（连接池里来回，最慢）
  const tC0 = Date.now()
  for (const d of data(2)) {
    await prisma.post.create({ data: d })
  }
  const tC = Date.now() - tC0

  show('批量插入 500 行对比', {
    'A. createMany':           `${tA} ms (insert ${aResult.count})`,
    'B. $transaction([create*N])': `${tB} ms`,
    'C. for await create':     `${tC} ms`,
    '倍率 C/A':                (tC / tA).toFixed(1),
    '倍率 B/A':                (tB / tA).toFixed(1),
  })

  // 清理
  const cleaned = await prisma.post.deleteMany({
    where: { slug: { startsWith: `perf-${stamp}-` } },
  })
  console.log(`  ▸ 清理临时数据 ${cleaned.count} 行`)

  // --------------------------------------------------------------------------
  section('9.2 并发能力：连接池大小决定吞吐')
  // --------------------------------------------------------------------------
  const concurrency = 20
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      // ★ pg_sleep 返回 void，$queryRaw 会反序列化失败；用 $executeRaw（不读返回）
      await prisma.$executeRaw`SELECT pg_sleep(0.05)`   // 模拟 50ms 慢查询
    }),
  )
  const elapsed = Date.now() - t0
  show(`${concurrency} 并发 × 50ms 模拟查询`, {
    总耗时:   `${elapsed} ms`,
    理论串行: `${concurrency * 50} ms`,
    理论完美并行: '50 ms（前提：连接池 >= 并发数）',
    实际:     elapsed < 200 ? '✅ 连接池够' : '⚠️ 池小或 PG 慢',
  })
  console.log(`
  ★ 默认 connection_limit = num_cpus * 2 + 1。
    Lambda / Edge 环境必须显式：DATABASE_URL?connection_limit=1&pool_timeout=20
    （加上 PgBouncer 的 transaction 模式做外部池化）
  `)

  // --------------------------------------------------------------------------
  section('9.3 慢查询统计')
  // --------------------------------------------------------------------------
  show('本次跑出 > 50ms 的查询数', slowCount)
  console.log(`
  ★ 生产环境把 query event 接到 APM (Datadog/NewRelic/OpenTelemetry)；
    本地用 console.warn 阈值 + 抽样就够定位 N+1 / 索引缺失。
  `)

  // --------------------------------------------------------------------------
  section('9.4 $transaction batch 的局限：长事务 = 长锁')
  // --------------------------------------------------------------------------
  console.log(`
  ★ 上面 §9.1 的方式 B 把 500 条 INSERT 包成事务：500 条 INSERT 期间
    一直持有写锁。生产中要避免——批量写优先用 createMany 或裸 SQL COPY。
  ★ 事务时长黄金法则：
      - 总时长 < 100ms 为佳
      - 不要在事务里 await HTTP / 文件 IO / 消息队列
      - 不要在事务里跑 N+1，每条都是一次 round trip
  `)

  console.log('\n✅ 09_perf 全部跑完\n')
}

main()
  .catch(err => {
    console.error('❌ demo 失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
