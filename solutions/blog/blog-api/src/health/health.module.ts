import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

// TerminusModule.forRoot() 提供 HealthCheckService + 内置 indicator（PrismaHealthIndicator 等）。
// PrismaService / RedisService 是 @Global 模块（PrismaModule / CacheModule），这里直接注入即可。
// RedisHealthIndicator 是 terminus 没内置的自定义指标，本模块自己 provide。
@Module({
  imports: [TerminusModule.forRoot()],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
