import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

// main.ts 只做装配：bootstrap、CORS、shutdown hooks、listen
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

  const port = config.get('port', { infer: true });
  await app.listen(port);
  Logger.log(`🚀 Day 20 Blog API listening on http://localhost:${port}`, 'Bootstrap');
}

bootstrap();
