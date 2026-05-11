import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 全局 Pipe / Interceptor / Filter
  // 注：Guard 不在这里 new，而是用 APP_GUARD provider 注入（见 AppModule），
  // 否则 Guard 内部 inject 的 Reflector 会是 undefined。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  console.log(`🚀 Day 17 Blog API: http://localhost:${port}`);
}

bootstrap();
