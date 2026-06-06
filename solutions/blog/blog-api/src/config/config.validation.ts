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

  // Day 34：GitHub OAuth（可选——没配 client id/secret 就禁用 GitHub 登录，不影响启动）
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z
    .string()
    .default('http://localhost:3000/auth/github/callback'),
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
