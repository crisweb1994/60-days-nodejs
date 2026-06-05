import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../guards/jwt-auth.guard';

// 从 req.user（JwtAuthGuard 验完 token 后挂上的 payload）取当前用户。
// 用法：me(@CurrentUser() user: JwtPayload) { ... user.sub ... }
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload =>
    ctx.switchToHttp().getRequest().user,
);
