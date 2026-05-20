import { z } from 'zod';

// 用 zod 在启动时校验环境变量
// 配错一个变量应该在 `pnpm start` 第一秒报错，而不是等请求进来才崩
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // 多个域名用逗号分隔；空值留给开发期自己改 .env
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  PAGE_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
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
