import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

// 演示用「假鉴权」Guard：
// 真实项目里这里会解 JWT、查 session、调 OAuth。
// 我们这里偷个懒：从请求头 x-user 和 x-user-roles 直接读出来挂到 req.user。
// 目的是让后续 RolesGuard 能拿到 req.user.roles 做权限判定，把流水线跑通。
export interface RequestUser {
  id: string;
  roles: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: RequestUser;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride：先看 handler，再看 class，越具体的覆盖越宽的
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.header('x-user');
    const rolesHeader = req.header('x-user-roles');

    if (!userId) {
      throw new UnauthorizedException('未登录（缺少 x-user 请求头）');
    }

    req.user = {
      id: userId,
      roles: rolesHeader ? rolesHeader.split(',').map(s => s.trim()) : [],
    };
    return true;
  }
}
