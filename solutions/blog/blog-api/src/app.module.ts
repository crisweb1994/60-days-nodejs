import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { CommonModule } from './common/common.module';
import configuration from './config/configuration';
import { validateEnv } from './config/config.validation';
import type { AppConfig } from './config/configuration';
import { HealthModule } from './health/health.module';
import { PostsModule } from './posts/posts.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    // ConfigModule 必须在其他模块之前 import；其他地方注入 ConfigService 才能拿到
    ConfigModule.forRoot({
      isGlobal: true,
      // env 校验：缺/错环境变量在启动第一秒就崩，而不是请求进来才崩
      validate: (raw) => {
        const env = validateEnv(raw);
        return configuration(env);
      },
    }),
    // Day 35：限流。注册一个"默认"限流器，全局兜底（默认 1000/分钟，env 可调）。
    // 真正高风险的登录 / 注册在控制器上用 @Throttle 再单独收紧。
    // ★ ttl 是毫秒（throttler 要求），configuration.ts 里已从"秒"换算过来。
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => [
        {
          ttl: config.get('rateLimit.ttlMs', { infer: true }),
          limit: config.get('rateLimit.limit', { infer: true }),
        },
      ],
    }),
    CommonModule, // 全局 Filter / Interceptor / Pipe + Middleware 都在这里
    // Day 36：Redis 缓存。@Global 模块，任何模块都能直接注入 RedisService。
    CacheModule,
    // Day 38：消息队列（BullMQ）。@Global 模块，任何模块都能注入 MailQueueService 入队异步任务。
    QueueModule,
    // Day 39：文件上传与存储。@Global 模块，任何模块都能注入 STORAGE_SERVICE / ImageProcessorService。
    StorageModule,
    HealthModule,
    AuthModule, // Day 32：注册 / 登录 / JWT
    PostsModule,
  ],
  // 把 ThrottlerGuard 注册成全局守卫：每个请求都先过限流闸，超了抛 ThrottlerException(429)。
  // /health 用 @SkipThrottle() 豁免（探针高频，不该被限流误伤）。
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
