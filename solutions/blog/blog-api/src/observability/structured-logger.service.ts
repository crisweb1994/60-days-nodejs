import { Injectable } from '@nestjs/common';
import pino = require('pino');
import { appLogger } from './logger';

// 业务代码注入的「结构化日志服务」。薄薄包一层 appLogger，统一成「字段优先」的 API。
//
// 为什么不直接 appLogger.info(...) 满天飞：
//   1. 注入后，单测可替换成假实现（不必捕获 stdout）；
//   2. 未来要加 trace context / 改输出格式 / 接 OpenTelemetry，都只改这一处，调用方不动；
//   3. 它强制「先对象后文案」的纪律——日志是给机器按字段查的，不是给人读散文的。
//
// 用法：logger.info({ postId, userId, durationMs }, 'post fetched')
//   pino 会把对象合并进这行、把文案放进 msg 字段。绝不要 logger.info(`fetched ${id}`)——
//   那样 id 被焊死在字符串里，采集后没法按 postId= 聚合。
@Injectable()
export class StructuredLoggerService {
  private readonly logger: pino.Logger = appLogger;

  info(obj: Record<string, unknown>, msg?: string): void {
    this.logger.info(obj, msg);
  }

  warn(obj: Record<string, unknown>, msg?: string): void {
    this.logger.warn(obj, msg);
  }

  error(obj: Record<string, unknown>, msg?: string): void {
    this.logger.error(obj, msg);
  }

  debug(obj: Record<string, unknown>, msg?: string): void {
    this.logger.debug(obj, msg);
  }
}
