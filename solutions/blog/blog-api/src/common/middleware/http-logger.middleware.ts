import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { StructuredLoggerService } from '../../observability/structured-logger.service';

// 结构化访问日志。挂在 res.on('finish') 上而不是 next() 之前——
// 这样能拿到最终的 status 和总耗时（含所有 interceptor / filter 的处理）。
//
// 字段式而非字符串拼接：采集后能 `jq 'select(.status>=500)'` 按字段过滤、
// 按 url 聚合 QPS、按 durationMs 算 P99——这是「结构化日志」相对 `console.log` 的全部价值。
// 级别随 status 走：5xx→error（触发告警）、4xx→warn、其余 info。
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: StructuredLoggerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const requestId = req.headers['x-request-id'] as string | undefined;

    res.on('finish', () => {
      const status = res.statusCode;
      const fields = {
        method: req.method,
        url: req.originalUrl,
        status,
        durationMs: Date.now() - start,
        requestId: requestId ?? undefined, // 显式带上；pino 的 mixin 也会再补一次（CLS 里那份）
      };
      if (status >= 500) this.logger.error(fields, 'http request');
      else if (status >= 400) this.logger.warn(fields, 'http request');
      else this.logger.info(fields, 'http request');
    });

    next();
  }
}
