import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService = PrismaClient + Nest 生命周期。
 *
 * 为什么 extends 而不是组合（new PrismaClient() 塞进字段）：
 *   继承之后这个 service 本身就是一个 PrismaClient，调用方写 this.prisma.post.xxx，
 *   API 和裸 client 完全一致，没有额外转发层。
 *
 * 为什么实现 OnModuleInit / OnModuleDestroy：
 *   - onModuleInit：应用启动时主动 $connect()，让"连不上数据库"在启动第一秒就暴露，
 *     而不是等第一个请求进来才报错（和 Day 20 的 zod env 校验同一个哲学：fail fast）。
 *   - onModuleDestroy：进程收到关闭信号时 $disconnect()，把连接池干净地还给 PG。
 *
 * ★ 关闭信号能传到这里的前提是 main.ts 调了 app.enableShutdownHooks()——它已经有了。
 *   老教程里那套 this.$on('beforeExit', () => app.close()) 的写法在 Prisma 5 里
 *   已经不需要，也不推荐：beforeExit 在 Prisma 5 被移除了，靠 Nest 的 shutdown hook 即可。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      // 只把 warn / error 打到 stdout；想看每条 SQL 临时加 'query'
      log: ['warn', 'error'],
      // DATABASE_URL 由 PrismaClient 自己从 process.env 读（schema.prisma 里 env("DATABASE_URL")）
      // ConfigModule 启动时已把 .env 灌进 process.env，所以这里能拿到
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PostgreSQL 连接已建立');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('PostgreSQL 连接已关闭');
  }
}
