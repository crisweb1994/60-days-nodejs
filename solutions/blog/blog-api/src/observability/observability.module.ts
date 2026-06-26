import { Global, Module } from '@nestjs/common';
import { ErrorReporter, SentryErrorReporter } from './error-reporter';
import { StructuredLoggerService } from './structured-logger.service';

// Day 45：可观测性的集中装配点。@Global——任何模块（过滤器 / 中间件 / service）都能直接注入，
//   不用各自 import。和 CommonModule（横切关注点）分工：这里只管「日志 + 上报」两个 provider。
@Module({
  providers: [
    StructuredLoggerService,
    // 用抽象类当 token：注入方写 `reporter: ErrorReporter`，Nest 按 token 解析到 SentryErrorReporter。
    { provide: ErrorReporter, useClass: SentryErrorReporter },
  ],
  exports: [StructuredLoggerService, ErrorReporter],
})
export class ObservabilityModule {}
