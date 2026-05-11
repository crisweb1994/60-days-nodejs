import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 全局校验管道：让 class-validator 装饰器生效
  // whitelist 剥离 DTO 未声明的字段；forbidNonWhitelisted 直接拒绝多余字段
  // transform 把 query/param 字符串按 DTO 类型自动转成 number/boolean
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`🚀 Blog API 已启动: http://localhost:${port}`);
}

bootstrap();
