import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, map } from 'rxjs';

export interface ApiResponse<T> {
  code: 0;
  data: T;
  message: 'ok';
  requestId?: string;
  timestamp: string;
}

// 成功响应统一外壳。错误路径不会经过 Interceptor 的 after 钩子，
// 所以错误响应的统一格式由 AllExceptionsFilter 负责。
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(ctx: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        data,
        message: 'ok',
        requestId: req.headers['x-request-id'] as string | undefined,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
