import type { Env } from './config.validation';

// 把 env 映射成强类型嵌套对象，业务代码读 config.get('cors.origin') 而不是 process.env.CORS_ORIGIN
// 这一层的好处：未来 CORS_ORIGIN 改名 / 拆分都只改这里，调用方不动
export default function configuration(env: Env) {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    database: {
      url: env.DATABASE_URL,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL, // 秒
      refreshTtlDays: env.REFRESH_TTL_DAYS,
    },
    oauth: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        callbackUrl: env.GITHUB_CALLBACK_URL,
      },
    },
    cors: {
      origin: env.CORS_ORIGIN.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    // Day 35：限流。ttl 在 env 里是秒（人读），这里换算成毫秒交给 @nestjs/throttler。
    rateLimit: {
      ttlMs: env.RATE_LIMIT_TTL * 1000,
      limit: env.RATE_LIMIT_LIMIT,
    },
    // Day 36：Redis 缓存。url 直传；两个 TTL 也原样透出，service 读取后作为 SET EX 的过期秒数。
    // Day 37 追加三个进阶参数：抖动（雪崩）、负缓存（穿透）、锁 TTL（击穿）。
    redis: {
      url: env.REDIS_URL,
      postTtlSec: env.POST_CACHE_TTL,
      listTtlSec: env.LIST_CACHE_TTL,
      ttlJitterSec: env.CACHE_TTL_JITTER,
      negativeTtlSec: env.NEGATIVE_CACHE_TTL,
      lockTtlSec: env.LOCK_TTL,
    },
    pagination: {
      defaultLimit: env.PAGE_LIMIT,
      maxLimit: 100,
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;
