import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { CoverUploadInterceptor } from './cover-upload.interceptor';
import { ImageProcessorService } from './image-processor.service';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_SERVICE } from './storage.constants';
import type { StorageService } from './storage.service';

// @Global：和 CacheModule / QueueModule 同级——存储是全应用基础设施，任何模块直接注入 STORAGE_SERVICE。
// 但今天只有 PostsModule 用它，仍做成全局，方便后续（用户头像、评论附件）复用同一后端。
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    ImageProcessorService,
    CoverUploadInterceptor,
    {
      // 按 STORAGE_BACKEND 选后端：local（默认）→ 本地磁盘；s3 → S3 兼容对象存储。
      // 用 useFactory 在启动时决定，把具体实现挂到 STORAGE_SERVICE 这个 token 上。
      provide: STORAGE_SERVICE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): StorageService => {
        const backend = config.get('storage.backend', { infer: true });
        if (backend === 's3') {
          // 选 S3 = 运营决定。关键凭证缺失应 fail-fast，而不是静默降级（和 Redis 的哲学相反）。
          if (!config.get('storage.s3.bucket', { infer: true })) {
            throw new Error(
              'STORAGE_BACKEND=s3 但未配置 S3_BUCKET——选了对象存储就配齐，别让请求打到一半才发现没有 bucket',
            );
          }
          return new S3StorageService(config);
        }
        return new LocalStorageService(config);
      },
    },
  ],
  // 导出 token + 图片处理 + 上传拦截器。后两个是 class，直接当 token 导出即可注入。
  exports: [STORAGE_SERVICE, ImageProcessorService, CoverUploadInterceptor],
})
export class StorageModule {}
