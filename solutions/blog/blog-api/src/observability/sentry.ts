import * as Sentry from '@sentry/node';

export interface SentryInitOptions {
  dsn?: string;
  environment: string;
  tracesSampleRate: number;
  release?: string;
}

// Day 45：Sentry 初始化。DSN 为空直接 return——可观测层「缺了只降级」，
// 绝不因为没配 Sentry 就让启动失败（这正是它和「DB 必填」的不对称：真相源缺了崩，观测层缺了静默）。
//
// 即便 DSN 有值但网络不通，Sentry.init 本身也不抛——SDK 把上报失败吞进自身日志，
// 永远不影响业务请求。captureException 同理是「入队上报」，fire-and-forget。
//
// 我们不调 Sentry.Handlers.requestHandler / setupExpressErrorHandler：那会和 Nest 的
// AllExceptionsFilter 抢错误处理（过滤器先响应了，Sentry 的 handler 就看不到错误了）。
// 取而代之，我们在过滤器里【显式】captureException——更可控、也更好测。
export function initSentry(opts: SentryInitOptions): void {
  if (!opts.dsn) return;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    tracesSampleRate: opts.tracesSampleRate,
    ...(opts.release ? { release: opts.release } : {}),
  });
}
