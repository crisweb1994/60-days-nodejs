import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import type { AppConfig } from '../config/configuration';

// 「错误上报」抽象。用抽象类（而非 interface）是为了能直接当 Nest 的 DI token——
//   interface 在运行时不存在，没法 provide。抽象类既是类型、又是值，两头都占。
//   生产实现把异常推给 Sentry；测试用假实现断言「确实调过 capture」，不必碰真 Sentry。
export abstract class ErrorReporter {
  abstract capture(exception: unknown, context?: Record<string, unknown>): void;
}

// Sentry 上报。和 Redis / 队列同属「可选层」：没配 SENTRY_DSN 时 capture 直接 no-op。
//   即便 SDK 已 init，captureException 本身也不抛（入队上报）——但显式 early-return 更省一次调用、
//   也让「这进程到底有没有在上报」一目了然（看 enabled 即可）。
@Injectable()
export class SentryErrorReporter extends ErrorReporter {
  private readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    super();
    this.enabled = Boolean(config.get('observability.sentry.dsn', { infer: true }));
  }

  capture(exception: unknown, context?: Record<string, unknown>): void {
    if (!this.enabled) return;
    // 给这条事件挂上「触发它的请求」上下文 + requestId tag——
    // 在 Sentry 里看到一个错误，能立刻按 requestId 回查到这条请求的访问日志，闭环定位。
    Sentry.withScope((scope) => {
      if (context) scope.setContext('request', context);
      const reqId = context?.requestId;
      if (typeof reqId === 'string') scope.setTag('requestId', reqId);
      Sentry.captureException(exception);
    });
  }
}
