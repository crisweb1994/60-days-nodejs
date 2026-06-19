import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { getRequestContext } from '../request-context';

/**
 * 把请求上下文里的缓存命中状态，写成 X-Cache / X-Cache-Key 响应头。
 *
 * 为什么要放在拦截器的 tap（请求成功之后）里读，而不是在 intercept 开头读？
 *   缓存命中与否，是 service 在「处理请求的过程中」才知道的（先查缓存才有结论）。
 *   所以得等 handler 跑完（next.handle() 的数据流完成）再去读上下文——这时
 *   service 已经把 HIT/MISS 写进去了。CLS 会沿着这条异步链一路传过来，tap 里能读到。
 *
 * 这个头纯粹是可观测性，让 `curl -i` 一眼看见缓存有没有生效——它不参与任何业务逻辑。
 */
@Injectable()
export class CacheHeaderInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap(() => {
        const { cache, cacheKey } = getRequestContext();
        if (cache) {
          res.setHeader('X-Cache', cache);
          if (cacheKey) res.setHeader('X-Cache-Key', cacheKey);
        }
      }),
    );
  }
}
