import type { Env } from './config.validation';

// 把 env 映射成强类型嵌套对象，业务代码读 config.get('cors.origin') 而不是 process.env.CORS_ORIGIN
// 这一层的好处：未来 CORS_ORIGIN 改名 / 拆分都只改这里，调用方不动
export default function configuration(env: Env) {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    cors: {
      origin: env.CORS_ORIGIN.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    pagination: {
      defaultLimit: env.PAGE_LIMIT,
      maxLimit: 100,
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;
