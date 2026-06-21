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
      // Day 40：账号锁定（暴力破解对策）。阈值 + 锁定窗口（秒）。锁定状态落在 Redis，
      // 连不上就静默关闭——和缓存「可选层」哲学一致，绝不因它连累登录主流程。
      lockout: {
        maxAttempts: env.LOGIN_MAX_ATTEMPTS,
        windowSec: env.LOGIN_LOCK_MINUTES * 60,
      },
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
    // Day 40：HTTP 层硬上限。别依赖 Express 的隐式默认（不同版本会变）——把「JSON 请求体
    // 最大多少 KB」写进配置、显式交给 body-parser，超大 payload 在解析阶段就被拒成 413。
    http: {
      bodyLimitKb: env.HTTP_BODY_LIMIT_KB,
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
    // Day 38：消息队列（BullMQ，基于上面的同一个 Redis）。复用 redis.url，不再单独配连接串。
    // 队列同样是「可选的异步基础设施」——连不上只影响「邮件异步发送」，不影响主流程，故都有默认值。
    queue: {
      attempts: env.MAIL_ATTEMPTS, // 单个任务最多尝试次数（含首次）
      backoffMs: env.MAIL_BACKOFF_MS, // 指数退避的基准间隔（毫秒）
      concurrency: env.MAIL_CONCURRENCY, // 单 worker 进程并发处理数
      sentTtlSec: env.MAIL_SENT_TTL, // 幂等标记「这封已发过」的存活秒数
    },
    // Day 39：文件上传与存储。默认本地磁盘（零配置可用）；改 backend=s3 走 S3 兼容对象存储。
    // 存储同样是「可选真相外层」——但它和 Redis 的降级哲学相反：
    //   默认 local 永远可用；一旦显式选 s3，配错（缺 bucket）应启动即崩（fail-fast），
    //   而不是悄悄降级——因为「选对象存储」是运营决定，配错就该立刻炸出来。
    storage: {
      backend: env.STORAGE_BACKEND, // 'local' | 's3'
      localDir: env.STORAGE_LOCAL_DIR, // local：写入根目录（相对 cwd）
      localPublicPrefix: env.STORAGE_PUBLIC_PREFIX, // local：对外 URL 前缀（express static 的 prefix）
      upload: {
        maxBytes: env.UPLOAD_MAX_BYTES, // multer 硬上限：超了在缓冲阶段就中断
      },
      cover: {
        maxWidth: env.COVER_MAX_WIDTH, // 缩放到最大宽度（不放大）
        format: env.COVER_FORMAT, // 归一化目标格式：webp（默认）/ jpeg / png
      },
      s3: {
        endpoint: env.S3_ENDPOINT, // R2: https://<account>.r2.cloudflarestorage.com；MinIO: http://localhost:9000；AWS 留空
        region: env.S3_REGION, // R2 用 auto；AWS 用 region；MinIO 任意
        bucket: env.S3_BUCKET, // 桶名（backend=s3 时必填，缺则启动崩）
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE, // MinIO / 自建 true；R2 / AWS false
        publicBaseUrl: env.S3_PUBLIC_BASE_URL, // CDN / R2 公开域名；不填则按 endpoint+bucket 拼路径风格 URL
      },
    },
    pagination: {
      defaultLimit: env.PAGE_LIMIT,
      maxLimit: 100,
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;
