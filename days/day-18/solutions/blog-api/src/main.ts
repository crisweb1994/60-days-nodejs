import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // 把校验失败转成结构化响应，便于前端按字段定位错误
      exceptionFactory: (errors) => {
        const formatted = errors.flatMap(function flatten(err, parentPath = ''): any[] {
          const path = parentPath ? `${parentPath}.${err.property}` : err.property;
          const own = err.constraints
            ? [{ field: path, messages: Object.values(err.constraints) }]
            : [];
          const children = (err.children ?? []).flatMap((c) => flatten(c, path));
          return [...own, ...children];
        });
        return new BadRequestException({
          code: 'VALIDATION_ERROR',
          errors: formatted,
        });
      },
    }),
  );

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`🚀 Day 18 Blog API: http://localhost:${port}`);
}

bootstrap();
