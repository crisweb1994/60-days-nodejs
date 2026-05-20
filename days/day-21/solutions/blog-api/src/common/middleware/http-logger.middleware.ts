import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

// 全局访问日志。挂在 res.on('finish') 上而不是 next() 之前，
// 这样能拿到最终的 status 和总耗时（包括所有 interceptor 和 filter 的处理）
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const requestId = req.headers['x-request-id'] as string | undefined;

    res.on('finish', () => {
      const ms = Date.now() - start;
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms reqId=${requestId ?? '-'}`;
      // 5xx 走 error，4xx 走 warn，其余 log。日志级别能直接被采集系统按维度过滤
      if (res.statusCode >= 500) this.logger.error(line);
      else if (res.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }
}
