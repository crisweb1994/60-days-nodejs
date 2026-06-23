import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';
import { PrismaService } from '../prisma/prisma.service';

// Day 35：探针会高频打 /health（每个容器几秒一次），从同一个内网 IP 来——
// 不豁免的话，限流会把它误伤成 429，探针以为服务挂了。所以显式跳过限流。
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly db: PrismaService,
  ) {}

  // ── 存活探针（liveness）：进程在不在 ──────────────────────────────────
  // 只查进程级状态，不碰 DB / Redis——又快又稳，适合被 docker healthcheck /
  // k8s livenessProbe 高频打。Day 41 的 Dockerfile HEALTHCHECK 打的就是这条。
  // 它和「就绪」故意分开：进程活着不代表「能服务请求」，后者要查下游（见 /ready）。
  @Get()
  @ApiOperation({ summary: '存活探针：进程级，不查 DB/Redis（探针高频，请勿依赖它判断可服务）' })
  liveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  // ── 就绪探针（readiness）：能不能接流量 ────────────────────────────────
  // 「存活」问进程在不在，「就绪」问能不能真的服务请求——后者要确认下游连得上。
  // terminus 在任一指标 down 时抛 ServiceUnavailableException(503)；
  // compose 的 depends_on: service_healthy 就靠这条（覆盖了镜像内置的 liveness 探针）
  // 判断「api 现在能不能接流量」。
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: '就绪探针：查 DB + Redis，任一不可用返回 503' })
  readiness() {
    return this.health.check([
      // 真相源：DB 连不上，应用无法服务任何请求 → 必须影响就绪判定。
      // pingCheck 底层就是一条 `SELECT 1`——能跑通说明连接池活着、DB 可达。
      () => this.prisma.pingCheck('database', this.db),
      // 缓存层：连不上应用也能降级（直连 DB）。这里仍纳入就绪判定，是为了让编排器
      // 在缓存没就绪时先别导流量——避免首批请求冷启动穿透打到 DB（cache stampede）。
      // 若你的部署里 Redis 真可能缺席、又希望 api 照常 ready，删掉这一条即可
      // （详见 README「就绪判定的边界」一节）。
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
