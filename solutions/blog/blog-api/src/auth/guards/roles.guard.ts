import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { JwtPayload } from './jwt-auth.guard';

/**
 * 角色守卫（纯 RBAC，不看具体资源）。
 * - 读 @Roles 声明的角色；没声明 = 不限角色，放行。
 * - 必须排在 JwtAuthGuard **之后**（@UseGuards(JwtAuthGuard, RolesGuard)）——
 *   那样 req.user 已由前者填好。
 *
 * 注意它只管"角色"这种**上下文无关**的判断。"只有作者能改自己的文章"那种**资源级**
 * 权限需要先把文章查出来，放在 Service 里做更合适（见 PostsService.assertCanModify）。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = ctx
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>().user;
    if (!user) {
      throw new BusinessException(
        ErrorCodes.UNAUTHORIZED,
        '未认证',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!required.includes(user.role)) {
      throw new BusinessException(
        ErrorCodes.FORBIDDEN,
        '权限不足',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
