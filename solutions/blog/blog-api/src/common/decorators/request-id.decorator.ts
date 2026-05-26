import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// 让 Controller 不用每次都写 `@Headers('x-request-id') id: string`
// 用法：`handler(@RequestId() id: string) {}`
export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const id = req.headers['x-request-id'];
    return typeof id === 'string' ? id : undefined;
  },
);
