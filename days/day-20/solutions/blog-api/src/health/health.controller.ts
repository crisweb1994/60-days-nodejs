import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
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
