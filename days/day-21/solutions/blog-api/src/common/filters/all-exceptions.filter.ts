import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// 兜底过滤器：@Catch() 不传参 → 接所有异常
// 处理策略：
//   - HttpException：业务/客户端预期错误，透传 message + 业务 code
//   - 未知异常：服务端 bug，打栈 + 脱敏文案，绝不把 error.message 漏给客户端
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // HttpException.getResponse() 可能是字符串，也可能是对象（如 BusinessException 塞的 { code, message }）
    const raw = isHttp ? exception.getResponse() : null;
    const payload: Record<string, any> =
      typeof raw === 'string' ? { message: raw } : (raw as Record<string, any>) ?? {};

    // 5xx 是服务端责任，必须能复盘；4xx 是客户端责任，量大时不打
    if (!isHttp) {
      this.logger.error(
        `${req.method} ${req.url} → 500`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} → ${status}`, JSON.stringify(payload));
    }

    const requestId = req.headers['x-request-id'] as string | undefined;

    // 失败响应 = 成功响应外壳的镜像，前端用同一套类型解
    res.status(status).json({
      code: payload.code ?? status,        // 业务码优先，回落到 HTTP 码
      data: null,
      message: isHttp
        ? Array.isArray(payload.message)
          ? payload.message.join('; ')
          : payload.message ?? 'Request failed'
        : '服务器内部错误',                // 未知异常永远用固定文案
      errors: payload.errors,              // 校验明细（来自 day-18 的 exceptionFactory）
      path: req.url,
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
