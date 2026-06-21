import { Global, Module } from '@nestjs/common';
import { LoginAttemptService } from './login-attempt.service';
import { RedisLockService } from './redis-lock.service';
import { RedisService } from './redis.service';

// @Global：Redis 是全应用基础设施（和 Prisma 同级），任何模块都能直接注入 RedisService /
// RedisLockService / LoginAttemptService，不用在每个模块的 imports 里重复声明。
@Global()
@Module({
  providers: [RedisService, RedisLockService, LoginAttemptService],
  exports: [RedisService, RedisLockService, LoginAttemptService],
})
export class CacheModule {}
