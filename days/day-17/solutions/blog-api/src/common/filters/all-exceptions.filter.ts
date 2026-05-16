import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// 兜底异常过滤器
// - @Catch() 不传参 → 接所有异常，应放在最外层
// - 区分 HttpException（业务/客户端错误，正常 log）与未知异常（Server 错误，error log + 隐藏细节）
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // HttpException 的 message 可能是字符串，也可能是 { message, error, statusCode } 对象
    // 取里面的 message 字段，否则用 exception.message
    let message: string | string[] = '服务器内部错误';
    if (isHttp) {
      const r = exception.getResponse();
      message = typeof r === 'string' ? r : (r as { message: string }).message;
    }

    // 未知异常打详细栈；HttpException 是预期内的，只 warn
    if (!isHttp) {
      this.logger.error(
        `${req.method} ${req.url} → 500`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} → ${status}: ${message}`);
    }

    res.status(status).json({
      code: status,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
