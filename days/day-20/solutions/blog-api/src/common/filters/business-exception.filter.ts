import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { ErrorCode } from '../constants/error-codes';
import { BusinessException } from '../exceptions/business.exception';

// 演示"控制器级 filter + 精确匹配"如何在全局 filter 之前接管
// 只接 BusinessException，给响应加 category: 'business' 标记
// 抛 Error / 抛其他 HttpException 都会落到外层 AllExceptionsFilter
@Catch(BusinessException)
export class BusinessExceptionFilter implements ExceptionFilter<BusinessException> {
  private readonly logger = new Logger('BusinessException');

  catch(exception: BusinessException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception.getStatus();
    const { code, message } = exception.getResponse() as { code: ErrorCode; message: string };

    // 业务错误按 code 维度统计比按 HTTP 状态码有用得多
    this.logger.warn(`${req.method} ${req.url} → ${status} [${code}] ${message}`);

    res.status(status).json({
      code,
      data: null,
      message,
      category: 'business',
      path: req.url,
      requestId: req.headers['x-request-id'] as string | undefined,
      timestamp: new Date().toISOString(),
    });
  }
}
