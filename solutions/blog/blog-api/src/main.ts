import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

// main.ts 只做装配：bootstrap、CORS、shutdown hooks、Swagger、listen
// 任何业务代码出现在这里都是异味
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<AppConfig, true>);

  app.enableCors({
    origin: config.get('cors.origin', { infer: true }),
    credentials: true,
  });

  // 没开这个，容器 SIGTERM 时正在处理的请求会被一刀切断
  // OnApplicationShutdown 钩子也不会触发，连接池泄漏的经典源头
  app.enableShutdownHooks();

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
    .addTag('posts', '文章：增删改查 / 分页 / 搜索 / 并发控制')
    .addTag('health', '健康检查')
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
