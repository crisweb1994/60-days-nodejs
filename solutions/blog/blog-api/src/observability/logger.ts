import pino = require('pino');
import { getRequestContext } from '../common/request-context';

// Day 45：结构化日志的「源头」。这一个 pino 实例是全应用共享的——
//   访问日志、慢请求、异常、（未来）业务日志都从它出。
// 为什么是进程级单例、而不是注入 ConfigService 的 provider：
//   中间件 / 过滤器在 Nest DI 容器初始化【之前】就要用它（中间件在 configure() 里装配，
//   而那时 ConfigService 还没烘焙好）。所以它只能读 process.env，不能读 ConfigService。
//   ★ 但 LOG_LEVEL 也会被 config.validation.ts 校验一遍——真写错值照样启动即崩；这里读的是「已过校验」的值。

export interface CreateLoggerOptions {
  level: string;
  /** true = 开发期 pino-pretty 彩色人类可读；false = 裸 JSON（生产 / 测试，机器可解析）。 */
  pretty: boolean;
  /** 自定义输出流（测试里用它把日志收进 buffer 做断言；不传则写 stdout）。 */
  stream?: NodeJS.WritableStream;
}

export function createLogger(opts: CreateLoggerOptions): pino.Logger {
  const base: pino.LoggerOptions = {
    level: opts.level,
    base: { app: 'blog-api' }, // 每行都带的应用标识，采集后能按 app 过滤
    // ★ mixin 是 pino 的扩展点：每写一行日志前调一次，返回值会被【合并】进这行。
    //   我们用它把「当前请求的 requestId」自动挂上——调用方完全不用传 reqId，
    //   只要这行日志是在某请求的异步链里打的，CLS 里就有那个请求的 id，日志自然就关联上了。
    //   这就是「单进程链路追踪」的实现：requestId 从 HTTP 边界一路带到深层 service 的日志。
    mixin: () => {
      const requestId = getRequestContext().requestId;
      return requestId ? { requestId } : {}; // CLS 外（启动期）不挂，避免污染非请求日志
    },
    // 防御性脱敏：万一谁把整个 req 对象打出来，敏感字段被盖成 [REDACTED]。
    //   我们的访问日志只挑 method/url/status/duration，本就不碰这些——redact 是兜底，不是主防线。
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.newPassword',
        'req.body.refreshToken',
        'password',
        'newPassword',
        'refreshToken',
      ],
      censor: '[REDACTED]',
    },
  };

  // 开发用 pino-pretty：终端彩色、人类可读。生产 / 测试用裸 JSON：
  // 采集系统（ELK / Loki / Datadog）要的是能按字段 grep/jq 的结构化文本，不是给人读的散文。
  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(base, opts.stream ?? pino.destination(1)); // destination(1) = 同步写 stdout
}

// 进程级单例。业务代码通过 StructuredLoggerService 注入它；中间件 / 过滤器直接 import 它。
export const appLogger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  pretty: process.env.NODE_ENV === 'development',
});
