import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// 练习 2：统一响应封装
// 仅在 handler 正常返回时介入；异常会跳到 ExceptionFilter，由 Filter 负责错误格式
// —— 这是 day-17 README 里强调的「Interceptor 管成功、Filter 管失败」分工
export interface ApiResponse<T> {
  data: T;
  meta: {
    tookMs: number;
    timestamp: string;
  };
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    const start = Date.now();
    return next.handle().pipe(
      map(data => ({
        data,
        meta: {
          tookMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
