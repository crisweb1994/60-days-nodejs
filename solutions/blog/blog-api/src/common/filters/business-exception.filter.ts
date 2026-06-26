import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { ErrorCode } from '../constants/error-codes';
import { BusinessException } from '../exceptions/business.exception';
import { appLogger } from '../../observability/logger';

// 演示"控制器级 filter + 精确匹配"如何在全局 filter 之前接管
// 只接 BusinessException，给响应加 category: 'business' 标记
// 抛 Error / 抛其他 HttpException 都会落到外层 AllExceptionsFilter
//
// 这个过滤器经 @UseFilters 挂在 PostsController 上、在 PostsModule 上下文里实例化。
// 观测层虽是 @Global，但 per-controller filter 的依赖解析不如全局 APP_* 那么稳，
// 所以它和改版前一样不靠 DI——直接用 appLogger 单例（它的 mixin 照样从 CLS 带 requestId）。
@Catch(BusinessException)
export class BusinessExceptionFilter implements ExceptionFilter<BusinessException> {
  catch(exception: BusinessException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception.getStatus();
    const { code, message } = exception.getResponse() as { code: ErrorCode; message: string };

    // 业务错误用【业务 code】当结构化字段，比 HTTP 状态码有用得多——
    // 采集后能 `jq 'select(.code=="INSUFFICIENT_STOCK")'` 看某个业务规则的触发量。
    appLogger.warn(
      { method: req.method, url: req.url, status, code, message, requestId: req.headers['x-request-id'] ?? undefined },
      'business exception',
    );

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
