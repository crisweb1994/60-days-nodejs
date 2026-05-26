import {
  BadRequestException,
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import type { ValidationError } from 'class-validator';

import { ErrorCodes } from './constants/error-codes';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { TimingInterceptor } from './interceptors/timing.interceptor';
import { TransformInterceptor } from './interceptors/transform.interceptor';
import { HttpLoggerMiddleware } from './middleware/http-logger.middleware';
import { RequestIdMiddleware } from './middleware/request-id.middleware';

interface FieldError {
  field: string;
  messages: string[];
}

// 把嵌套 DTO 的校验错误压平：errors[i].children[j].constraints → { field: 'a.b', messages: [...] }
function flattenErrors(errors: ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((err) => {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    const own: FieldError[] = err.constraints
      ? [{ field: path, messages: Object.values(err.constraints) }]
      : [];
    const children = err.children?.length ? flattenErrors(err.children, path) : [];
    return [...own, ...children];
  });
}

// 横切关注点的集中注册点
// 用 @Global() 是因为下面的 APP_* provider 要在整个应用生效；
// 业务 service 仍应通过普通 imports/exports 显式声明依赖。
@Global()
@Module({
  providers: [
    // 注册顺序就是执行顺序：Timing 在最外层，能测到全链路耗时
    // 写反（Timing 在内层）会让统计值偏小
    { provide: APP_INTERCEPTOR, useClass: TimingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    // 全局 ValidationPipe：注意 main.ts 不要再 useGlobalPipes，否则会跑两遍
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          transformOptions: { enableImplicitConversion: true },
          exceptionFactory: (errors) =>
            new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              message: '请求参数校验失败',
              errors: flattenErrors(errors),
            }),
        }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, HttpLoggerMiddleware)
      // /health 不进访问日志：会被探针高频调用，日志量没价值
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
