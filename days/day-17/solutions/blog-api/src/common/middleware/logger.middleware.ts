import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

// 练习 1：全局日志中间件
// - 在 res 'finish' 时打印，才能拿到最终 status 和耗时
// - /health 路径在 AppModule.configure 的 exclude 中过滤掉，这里不做条件分支
@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  // 用 Nest 内置 Logger 而不是 console，可以受日志级别 / 上下文统一管理
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    const { method, originalUrl } = req;
    // 取真实 IP：代理场景下应在 main.ts 调 app.set('trust proxy', true)
    const ip = req.ip || req.socket.remoteAddress;
    const ua = req.get('user-agent') ?? '-';

    res.on('finish', () => {
      // hrtime 返回纳秒，转毫秒并保留 2 位
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const len = res.get('content-length') ?? '-';
      this.logger.log(
        `${method} ${originalUrl} ${res.statusCode} ${len}b ${ms.toFixed(2)}ms - ${ip} "${ua}"`,
      );
    });

    next();
  }
}
