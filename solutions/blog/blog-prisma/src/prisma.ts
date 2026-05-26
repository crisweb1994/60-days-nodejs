import { PrismaClient } from '@prisma/client'

// 单例 client，避免多个文件 new 出多套连接池
// 生产里 long-lived process 应该只 new 一次
export const prisma = new PrismaClient({
  log: ['warn', 'error'],
  // 想看每条 SQL 改成 ['query', 'info', 'warn', 'error']
})

// 注册退出时关闭：避免 demo 跑完进程挂着
process.on('beforeExit', async () => {
  await prisma.$disconnect()
})

// 让序列化 bigint 不报错（$queryRaw count 等场景会用到）
// @ts-expect-error bigint 不在 toJSON 接口里，要手动 patch
BigInt.prototype.toJSON = function () {
  return this.toString()
}

// 统一的 demo header / footer 输出格式
export function section(title: string) {
  console.log('\n' + '═'.repeat(72))
  console.log('  ' + title)
  console.log('═'.repeat(72))
}

export function show(label: string, value: unknown) {
  console.log(`\n  ▸ ${label}`)
  console.log('    ' + JSON.stringify(value, null, 2).replace(/\n/g, '\n    '))
}
