import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

// Day 35：探针会高频打 /health（每个容器几秒一次），从同一个内网 IP 来——
// 不豁免的话，限流会把它误伤成 429，探针以为服务挂了。所以显式跳过限流。
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '健康检查（进程级，不查 DB，不进访问日志）' })
  check() {
    // 这里只查进程级状态，避免被探针高频调用拖垮下游
    // 接 PostgreSQL 之后会加 db: 'ok' 字段（用 @nestjs/terminus）
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
