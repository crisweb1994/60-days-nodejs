import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request } from 'express';

// 慢请求探测。注册顺序决定它在最外层 —— 测到的耗时覆盖其它 interceptor + handler
// 注册顺序写反（这个排在 TransformInterceptor 内层）会让统计值偏小
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Timing');
  private readonly slowMs = 500;

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      tap({
        next: () => this.report(req, Date.now() - start),
        // 抛错路径上 tap 不会被触发（rxjs 行为），慢错误请求由 HttpLoggerMiddleware 兜住
      }),
    );
  }

  private report(req: Request, ms: number): void {
    if (ms >= this.slowMs) {
      const reqId = req.headers['x-request-id'] as string | undefined;
      this.logger.warn(`SLOW ${req.method} ${req.originalUrl} ${ms}ms reqId=${reqId ?? '-'}`);
    }
  }
}
