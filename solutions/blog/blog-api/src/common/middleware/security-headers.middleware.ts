import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/configuration';

// Day 35：安全响应头。Helmet 是一组 Express 中间件，给每个响应钉上一批"浏览器安全指令"：
//   - X-Content-Type-Options: nosniff  → 禁止浏览器把 JSON 当 HTML 猜（嗅探是 XSS 的老朋友）
//   - X-Frame-Options: SAMEORIGIN     → 不让别站用 <iframe> 嵌我们（防点击劫持 clickjacking）
//   - Strict-Transport-Security       → 强制 HTTPS（HSTS）
//   - Content-Security-Policy         → 限制页面能加载哪些资源（见下方说明）
//
// 放成 Nest 中间件（而不是 main.ts 里 app.use(helmet())）的原因：它属于应用的横切配置，
// 这样 e2e 测试直接 NestFactory.create(AppModule) 也能拿到这些头，不用在每个测试里重复挂。
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  // 在构造时把 helmet 配置好一次，每个请求复用同一个 handler
  private readonly handler: ReturnType<typeof helmet>;

  constructor(config: ConfigService<AppConfig, true>) {
    const env = config.get('env', { infer: true });
    this.handler = helmet({
      // CSP 只在生产开：它默认会拦掉内联脚本/样式，而 /docs 的 Swagger UI 大量依赖内联脚本。
      // 开发/测试关掉，让 Swagger 能用；生产没有 Swagger（或应单独配 CSP 白名单）。
      contentSecurityPolicy: env === 'production',
      // 我们是给跨域前端（如 :5173 的 React）吃的 API，声明 cross-origin 才不会被
      // CORP 默认的 same-origin 在 no-cors 场景（<img src>、<script src> 等）挡掉。
      // 普通 fetch+cors 的请求 CORP 本就不强制，但跨域 API 直接这么写最直白。
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    });
  }

  use(req: Request, res: Response, next: () => void): void {
    this.handler(req, res, next);
  }
}
