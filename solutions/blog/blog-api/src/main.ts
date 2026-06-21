import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

// main.ts 只做装配：bootstrap、CORS、shutdown hooks、Swagger、listen
// 任何业务代码出现在这里都是异味
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<AppConfig, true>);

  app.enableCors({
    origin: config.get('cors.origin', { infer: true }),
    credentials: true,
  });

  // Day 40：JSON 请求体硬上限。别依赖 Express 的隐式默认（100kb，版本间会变）——显式交给
  // body-parser：超大 payload 在解析阶段就被拒成 413，而不是把几 MB 的 JSON 整坨灌进内存。
  // 文件上传走 multipart，由 multer 的 fileSize 闸管（Day 39），不经这条 json 解析。
  app.useBodyParser('json', {
    limit: `${config.get('http.bodyLimitKb', { infer: true })}kb`,
  });

  // 没开这个，容器 SIGTERM 时正在处理的请求会被一刀切断
  // OnApplicationShutdown 钩子也不会触发，连接池泄漏的经典源头
  app.enableShutdownHooks();

  // Day 39：本地存储后端时，把上传目录挂成静态资源——封面图对外就能用 /uploads/... 直接访问。
  // S3 后端不需要这步（文件在外部对象存储）。这里只在 backend=local 时挂，避免挂一个用不到的目录。
  if (config.get('storage.backend', { infer: true }) === 'local') {
    const dir = resolve(
      process.cwd(),
      config.get('storage.localDir', { infer: true }),
    );
    mkdirSync(dir, { recursive: true });
    app.useStaticAssets(dir, {
      // prefix 要和 configuration 里 storage.localPublicPrefix 对齐，URL 才拼得上。
      prefix: config.get('storage.localPublicPrefix', { infer: true }),
    });
  }

  // Day 30：Swagger / OpenAPI 文档。UI 在 /docs，机器可读 JSON 在 /docs-json。
  // 文档里说明统一响应外壳——因为 TransformInterceptor 给每个响应包了一层，
  // 各路由再用 @ApiEnvelope 把外壳 + data 模型拼出来（见 api-envelope.decorator.ts）。
  // 生产可用 NODE_ENV 把对外文档关掉；教学目的这里常开。
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Blog API')
    .setDescription(
      [
        'NestJS + Prisma + PostgreSQL 博客 API（Day 16–30 阶段二里程碑）。',
        '',
        '**统一响应外壳**：',
        '- 成功 `{ code: 0, data, message: "ok", requestId, timestamp }`',
        '- 失败 `{ code, data: null, message, category?, path, requestId, timestamp }`',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addTag('auth', '认证：注册 / 登录 / 刷新 / 登出 / 当前用户')
    .addTag('posts', '文章：增删改查 / 分页 / 搜索 / 并发控制')
    .addTag('health', '健康检查')
    // Day 32：在 /docs 右上角加 "Authorize" 按钮，把 access token 填进去就能试受保护接口
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = config.get('port', { infer: true });
  await app.listen(port);
  Logger.log(`🚀 Blog API listening on http://localhost:${port}`, 'Bootstrap');
  Logger.log(`📖 API docs at http://localhost:${port}/docs`, 'Bootstrap');
}

bootstrap();
