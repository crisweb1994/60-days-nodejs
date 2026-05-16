import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';

// 练习 3：角色权限 Guard
// 依赖前置 AuthGuard 已经把 req.user 填好。Nest 会按 UseGuards 注册顺序执行多个 guard，
// 所以全局先注册 AuthGuard、再注册 RolesGuard，能保证这里 req.user 一定存在。
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // 没标 @Roles() 的路由视为公开，直接放行
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) {
      // 理论上不该到这里：AuthGuard 没拦住却又没填 user
      throw new ForbiddenException('用户信息缺失');
    }

    const ok = required.some(role => user.roles.includes(role));
    if (!ok) {
      throw new ForbiddenException(
        `需要以下角色之一: [${required.join(', ')}]，当前: [${user.roles.join(', ') || '无'}]`,
      );
    }
    return true;
  }
}
