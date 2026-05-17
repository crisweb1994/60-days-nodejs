import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationError } from 'class-validator';
import { AppModule } from './app.module';

interface FieldError {
  field: string;
  messages: string[];
}

function flattenErrors(errors: ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((err) => {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    const own: FieldError[] = err.constraints
      ? [{ field: path, messages: Object.values(err.constraints) }]
      : [];
    const children = err.children?.length ? flattenErrors(err.children, path) : [];
    return [...own, ...children];
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // 把校验失败转成结构化响应，便于前端按字段定位错误
      exceptionFactory: (errors) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          errors: flattenErrors(errors),
        }),
    }),
  );

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`🚀 Day 18 Blog API: http://localhost:${port}`);
}

bootstrap();
