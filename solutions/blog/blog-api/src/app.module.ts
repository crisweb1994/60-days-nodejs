import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CommonModule } from './common/common.module';
import configuration from './config/configuration';
import { validateEnv } from './config/config.validation';
import { HealthModule } from './health/health.module';
import { PostsModule } from './posts/posts.module';

@Module({
  imports: [
    // ConfigModule 必须在其他模块之前 import；其他地方注入 ConfigService 才能拿到
    ConfigModule.forRoot({
      isGlobal: true,
      // env 校验：缺/错环境变量在启动第一秒就崩，而不是请求进来才崩
      validate: (raw) => {
        const env = validateEnv(raw);
        return configuration(env);
      },
    }),
    CommonModule, // 全局 Filter / Interceptor / Pipe + Middleware 都在这里
    HealthModule,
    PostsModule,
  ],
})
export class AppModule {}
