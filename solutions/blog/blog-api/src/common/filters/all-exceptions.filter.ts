import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes } from '../constants/error-codes';

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
    let status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // HttpException.getResponse() 可能是字符串，也可能是对象（如 BusinessException 塞的 { code, message }）
    const raw = isHttp ? exception.getResponse() : null;
    const payload: Record<string, any> =
      typeof raw === 'string' ? { message: raw } : (raw as Record<string, any>) ?? {};

    // Day 35：ThrottlerException 是个 HttpException(429)，getResponse() 只给了一串文案，
    // 没有业务 code。这里把 429 统一翻译成 RATE_LIMITED，让前端用同一套错误码逻辑处理。
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      payload.code = ErrorCodes.RATE_LIMITED;
      payload.message = '请求过于频繁，请稍后再试';
    }

    // Day 40：body-parser 的「请求体过大」是个普通 Error（不是 HttpException），默认会落到 500。
    // 但它本质是客户端错误（payload 太大），既不该污染 5xx 告警，也不该用「服务器内部错误」误导前端。
    // 凭它的特征签名（type / status）识别出来，翻译成 413 BODY_TOO_LARGE。
    if (!isHttp && isPayloadTooLarge(exception)) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      payload.code = ErrorCodes.BODY_TOO_LARGE;
      payload.message = '请求体过大，请减小提交内容';
    }

    // 5xx 是服务端责任，必须能复盘；4xx 是客户端责任，量大时不打
    if (!isHttp && status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} → ${status}`,
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

// Day 40：识别 body-parser 抛的 PayloadTooLargeError。它在 Express 里不是 HttpException，
// 但带 type='entity.too.large'、或 status/statusCode=413——两个签名都认，免得不同版本漏判。
function isPayloadTooLarge(exception: unknown): boolean {
  const e = exception as { type?: string; status?: number; statusCode?: number };
  return (
    e?.type === 'entity.too.large' ||
    e?.status === HttpStatus.PAYLOAD_TOO_LARGE ||
    e?.statusCode === HttpStatus.PAYLOAD_TOO_LARGE
  );
}
