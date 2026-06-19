import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { requestContextStorage } from '../request-context';

// 在请求最外层开一个 AsyncLocalStorage 上下文。
// 后续整条异步链（controller → service → 拦截器的 after 钩子）都在这个 store 里，
// 任何一处 getRequestContext() 拿到的都是同一份、且只属于「这一个请求」。
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    requestContextStorage.run({}, () => next());
  }
}
