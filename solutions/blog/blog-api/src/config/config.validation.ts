import { z } from 'zod';

// 用 zod 在启动时校验环境变量
// 配错一个变量应该在 `pnpm start` 第一秒报错，而不是等请求进来才崩

// .env.example 里的示例 secret——生产环境出现它就拒绝启动（防占位值被带上线）
const EXAMPLE_JWT_SECRET = 'dev-only-access-secret-change-me-please';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // 多个域名用逗号分隔；空值留给开发期自己改 .env
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  PAGE_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  // Day 27：数据库连接串。必填——没有它 Prisma 连不上，应该启动即崩而不是首个请求才崩。
  // PrismaClient 会自己从 process.env.DATABASE_URL 读，这里加进 schema 只为 fail-fast 校验。
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres'), {
      message: 'DATABASE_URL 必须是 postgresql:// 连接串',
    }),

  // Day 32：JWT。access secret 必填且要够长——弱 secret/泄露 = 任何人都能伪造 token。
  // 没有默认值是故意的：缺了就启动报错，逼你显式配一个强随机串（别进代码库）。
  // 至少 32 字符：HS256 的密钥强度建议 ≥256-bit（如 openssl rand -base64 32）。
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET 至少 32 个字符（HS256 建议 ≥256-bit，如 openssl rand -base64 32）'),
  // access token 存活秒数，默认 15 分钟——短一点，配可撤销 refresh 续期
  JWT_ACCESS_TTL: z.coerce.number().int().min(60).default(900),
  // refresh token 存活天数，默认 7 天
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(7),

  // Day 35：限流。这是"每 IP 在窗口内最多多少请求"的"总闸"，默认给得宽（1000/分钟），
  // 不挡正常用户，只兜底暴力刷。登录 / 注册这条高风险路径在控制器上用 @Throttle 单独再收紧。
  // ttl 单位是秒（给人类读），进 configuration 时换算成毫秒（throttler 要 ms）。
  RATE_LIMIT_TTL: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().min(1).default(1000),

  // Day 36：Redis 缓存。注意它是「可选的真相外层」——和数据库的必填哲学相反：
  // 给了默认值、连不上也不让启动崩溃，最坏情况只是缓存不生效、请求直连数据库。
  // url 留个本地 docker 默认值；TTL 是「兜底失效」的秒数（哪怕忘了主动失效，到期也自动消失）。
  REDIS_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
      message: 'REDIS_URL 必须是 redis:// 或 rediss:// 连接串',
    })
    .default('redis://localhost:6379'),
  POST_CACHE_TTL: z.coerce.number().int().min(1).default(300), // 单篇缓存 5 分钟
  LIST_CACHE_TTL: z.coerce.number().int().min(1).default(60), // 列表缓存 1 分钟（变化更频繁，给短）
  // Day 37：缓存进阶三参数——雪崩抖动、穿透负缓存、击穿分布式锁。都有默认值，可不动。
  CACHE_TTL_JITTER: z.coerce.number().int().min(0).default(60), // 雪崩：TTL 随机抖动上限（秒）
  NEGATIVE_CACHE_TTL: z.coerce.number().int().min(1).default(30), // 穿透：负缓存（不存在）存活秒数
  LOCK_TTL: z.coerce.number().int().min(1).default(3), // 击穿：分布式锁存活秒数（≥ 最慢一次重建）

  // Day 38：消息队列（BullMQ）。和缓存一样是「可选异步层」，都有默认值、连不上也不让启动崩。
  // 重试 / 退避 / 并发是队列的三个核心旋钮：attempts 控「重不重试」，backoff 控「隔多久再试」，
  // concurrency 控「同时跑几个」。sentTtl 是幂等标记窗口，覆盖最坏重试链即可。
  MAIL_ATTEMPTS: z.coerce.number().int().min(1).default(3), // 含首次在内最多尝试次数
  MAIL_BACKOFF_MS: z.coerce.number().int().min(0).default(1000), // 指数退避基准（毫秒）
  MAIL_CONCURRENCY: z.coerce.number().int().min(1).default(4), // 单 worker 并发数
  MAIL_SENT_TTL: z.coerce.number().int().min(1).default(86_400), // 幂等标记存活秒数（默认 1 天）

  // Day 39：文件上传与存储。默认本地磁盘——零配置可用；改 STORAGE_BACKEND=s3 才需要补 S3_*。
  // 大小/尺寸都给保守默认：5 MiB 够封面图，1600px 宽够清晰又省带宽，webp 是体积/质量最优解。
  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default('uploads'), // local：写入根目录
  STORAGE_PUBLIC_PREFIX: z.string().default('/uploads'), // local：对外 URL 前缀
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(5 * 1024 * 1024), // 单文件硬上限（5 MiB）
  COVER_MAX_WIDTH: z.coerce.number().int().min(1).default(1600), // 封面归一化最大宽度
  COVER_FORMAT: z.enum(['webp', 'jpeg', 'png']).default('webp'),
  // S3 兼容（R2 / MinIO / AWS）——默认全空，只在 backend=s3 时才校验必填（见 StorageModule）。
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  // Day 34：GitHub OAuth（可选——没配 client id/secret 就禁用 GitHub 登录，不影响启动）
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z
    .string()
    .default('http://localhost:3000/auth/github/callback'),

  // Day 40：安全加固。两个方向——账号锁定（暴力破解对策）+ 请求体上限（大 payload DoS 对策）。
  // 锁定阈值/时长给保守默认（5 次失败锁 15 分钟，到点自动解锁）。测试里把阈值调小以快速触发。
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5), // 连续失败几次后锁定该账号
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15), // 锁定持续分钟数（到点自动解锁）
  HTTP_BODY_LIMIT_KB: z.coerce.number().int().min(1).default(100), // JSON 请求体硬上限（KB）——挡大 payload DoS
}).superRefine((env, ctx) => {
  // 生产环境拒绝使用 .env.example 的示例 secret——占位值上线 = 谁都能伪造 token
  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === EXAMPLE_JWT_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_ACCESS_SECRET'],
      message: '生产环境不能使用 .env.example 的示例 secret，请换成强随机串',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // ConfigModule 会把抛出的异常挂在启动失败上，message 直接打到 stderr
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败：\n${issues}`);
  }
  return result.data;
}
