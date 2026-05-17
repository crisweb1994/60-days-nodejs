import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { PostsModule } from './posts/posts.module';

@Module({
  imports: [PostsModule],
  providers: [
    // 用 APP_FILTER / APP_INTERCEPTOR 注册全局组件，而不是 main.ts 里 useGlobalXxx
    // 区别：这种方式走 DI，filter / interceptor 内部可以 inject 任何 provider
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
