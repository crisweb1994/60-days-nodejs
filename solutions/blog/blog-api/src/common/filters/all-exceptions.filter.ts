import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCodes } from '../constants/error-codes';
import { StructuredLoggerService } from '../../observability/structured-logger.service';
import { ErrorReporter } from '../../observability/error-reporter';

// 兜底过滤器：@Catch() 不传参 → 接所有异常
// 处理策略：
//   - HttpException：业务/客户端预期错误，透传 message + 业务 code
//   - 未知异常：服务端 bug，结构化打栈（err 字段交 pino serializer）+ 推 Sentry，绝不把 error.message 漏给客户端
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: StructuredLoggerService,
    // 注入抽象 token：生产是 SentryErrorReporter，测试塞个假实现断言「确实 capture 了」。
    private readonly reporter: ErrorReporter,
  ) {}

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

    const requestId = req.headers['x-request-id'] as string | undefined;
    const context = {
      method: req.method,
      url: req.url,
      status,
      requestId,
      code: payload.code,
    };

    // Day 45：结构化错误日志。err 字段名固定为 'err'——pino 默认对它跑 stdSerializers.err，
    // 把异常序列化成 { message, stack, type }，栈就自动进日志了。
    if (status >= 500) {
      this.logger.error(
        { ...context, err: exception },
        isHttp ? 'http exception' : 'unhandled exception',
      );
      // ★ 5xx 是服务端 bug，推一份到 Sentry 供复盘。
      //   4xx 是客户端责任（量大），不上报——否则告警噪音淹没真问题。业务 4xx 由 BusinessExceptionFilter 另记。
      this.reporter.capture(exception, context);
    }
    // 4xx 不在这里打日志（和原版一致：量大、客户端责任）。

    // 失败响应 = 成功响应外壳的镜像，前端用同一套类型解
    res.status(status).json({
      code: payload.code ?? status, // 业务码优先，回落到 HTTP 码
      data: null,
      message: isHttp
        ? Array.isArray(payload.message)
          ? payload.message.join('; ')
          : payload.message ?? 'Request failed'
        : '服务器内部错误', // 未知异常永远用固定文案，绝不漏 exception.message
      errors: payload.errors, // 校验明细（来自 day-18 的 exceptionFactory）
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
