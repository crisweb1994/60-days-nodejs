import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { setRequestId } from '../request-context';

// 给每个请求挂一个 requestId，Filter / Interceptor / Logger 都能拿到
// 上游如果已经带了 x-request-id（如网关注入），就尊重它，方便链路追踪
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    // Day 45：同步把 requestId 写进 CLS。这样「拿不到 req 的深层代码」（service / 异步回调）
    // 也能凭 CLS 让 pino 的 mixin 把 requestId 挂到日志上——链路追踪在单进程内闭环。
    // 前提：RequestContextMiddleware 必须在它之前运行（已在 CommonModule 里排在最外层）。
    setRequestId(id);
    next();
  }
}
