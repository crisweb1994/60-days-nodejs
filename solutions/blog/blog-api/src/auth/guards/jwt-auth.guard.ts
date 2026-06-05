import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';

// access token 的 payload（我们在 TokensService 里签的就是 sub + role）
export interface JwtPayload {
  sub: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * 校验 Authorization: Bearer <access token>。
 * verifyAsync 用 JwtModule 配的 secret + 算法 —— **算法是固定的**，不看 token header 里的 alg，
 * 所以天然不受 Day 31 提到的 alg:none / 算法混淆攻击影响。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw this.unauthorized('缺少 Bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      (req as Request & { user?: JwtPayload }).user = payload;
      return true;
    } catch {
      // 过期 / 篡改 / secret 不对都会到这
      throw this.unauthorized('token 无效或已过期');
    }
  }

  private unauthorized(message: string): BusinessException {
    return new BusinessException(
      ErrorCodes.UNAUTHORIZED,
      message,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
