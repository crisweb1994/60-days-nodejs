import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { RedisService } from '../cache/redis.service';

/**
 * RedisHealthIndicator —— 把「Redis 能不能 PING 通」包成一个 terminus 健康指标。
 *
 * 为什么自己写、不用现成的：
 *   terminus 内置了一堆 indicator（Prisma / TypeORM / Mongoose / DNS / Http …），
 *   偏偏【没有】ioredis 的——它早年的 Redis indicator 已被移除。但 terminus 的设计
 *   就是「写一个自定义 indicator 很便宜」：继承 HealthIndicator，用 super.getStatus()
 *   拼一个标准结果对象即可。这正好是 terminus 的扩展点。
 *
 *   ping 复用 RedisService 已有的 ping()：它内部已 try/catch，连不上返回 false
 *   而不是抛——和「缓存挂了不搞崩进程」的降级哲学一致（见 RedisService）。
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  /**
   * 返回 { redis: { status: 'up' } }，交给 HealthCheckService 聚合。
   *
   * ★ terminus 的约定（和内置 PrismaHealthIndicator 完全一致）：健康的指标【返回】结果对象；
   *   不健康的指标必须【抛】HealthCheckError——只返回 { status: 'down' } 不够，terminus 会把它
   *   当成普通 info，整体 status 仍是 'ok'、照样 200。抛了 HealthCheckError，HealthCheckService
   *   才会把这一项归入 error、把整体 status 翻成 'down' 并让 @HealthCheck 返回 503。
   */
  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const isHealthy = await this.redis.ping();
    if (isHealthy) {
      return this.getStatus(key, true);
    }
    throw new HealthCheckError(`${key} is not available`, this.getStatus(key, false));
  }
}
