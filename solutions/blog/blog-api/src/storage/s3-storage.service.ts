import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config/configuration';
import type { SaveInput, StoredFile, StorageService } from './storage.service';

/**
 * S3StorageService —— S3 兼容对象存储后端（AWS S3 / Cloudflare R2 / MinIO 共用同一套 API）。
 *
 * 为什么 S3 / R2 / MinIO 能用同一个客户端：
 *   它们都说 S3 协议（PutObject / GetObject / DeleteObject / HeadObject）。
 *   差异只是 endpoint 和「路径风格 vs 虚拟主机风格」：
 *     - AWS / R2：endpoint 留空或填区域端点，forcePathStyle=false（虚拟主机：<bucket>.s3...）。
 *     - MinIO / 自建：endpoint=http://localhost:9000，forcePathStyle=true（路径：localhost:9000/<bucket>/...）。
 *   一个 S3Client + 这两个旋钮，三个平台通吃。
 *
 * 和本地后端的差别（也是「选对象存储」的理由）：
 *   - 多实例共享：N 个 Pod 读写同一个 bucket，本地磁盘做不到（Day 37 击穿问题在文件层又出现一次）。
 *   - 无限容量 / 不占应用磁盘 / 可挂 CDN / 对象可直传（presigned URL）。
 *
 * ★ 它和 LocalStorageService 实现同一个抽象，业务零改动切换。
 */
@Injectable()
export class S3StorageService implements StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  readonly backend = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | undefined;
  private readonly endpoint: string | undefined;
  private readonly forcePathStyle: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.bucket = config.get('storage.s3.bucket', { infer: true });
    this.endpoint = config.get('storage.s3.endpoint', { infer: true }) || undefined;
    this.publicBaseUrl =
      config.get('storage.s3.publicBaseUrl', { infer: true }) || undefined;
    this.forcePathStyle = config.get('storage.s3.forcePathStyle', { infer: true });

    this.client = new S3Client({
      region: config.get('storage.s3.region', { infer: true }),
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
      credentials: {
        accessKeyId: config.get('storage.s3.accessKeyId', { infer: true }),
        secretAccessKey: config.get('storage.s3.secretAccessKey', { infer: true }),
      },
    });
  }

  /** 凭证齐全即视为「可用」；真正的可达性在每次操作里检验（catch → 抛回调用方）。 */
  get available(): boolean {
    return Boolean(this.bucket);
  }

  async save(input: SaveInput): Promise<StoredFile> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.buffer,
        ContentType: input.contentType,
        // 封面图是静态资源、内容寻址（key 含 uuid），缓存久一点无妨——减轻回源。
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return {
      key: input.key,
      url: this.publicUrl(input.key),
      size: input.buffer.length,
      contentType: input.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (e) {
      // 404 = 不存在；其它错误（网络 / 权限）才当真异常，这里降级成 false（best-effort）
      if (e instanceof S3ServiceException && e.$metadata?.httpStatusCode === 404) {
        return false;
      }
      this.logger.warn(`HeadObject 失败（按不存在处理）key=${key}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * 对外 URL 的「基座」（不含 key）：
   *   - 配了 publicBaseUrl（推荐：CDN / R2 公开域名 / 自定义域）→ 用它。
   *   - 否则按 endpoint 拼 path-style：endpoint/bucket（R2 / MinIO 都这样可用）。
   */
  private base(): string {
    if (this.publicBaseUrl) return this.publicBaseUrl;
    return `${this.endpoint ?? ''}/${this.bucket}`;
  }

  publicUrl(key: string): string {
    return `${this.base()}/${key}`;
  }

  keyFromPublicUrl(url: string): string | null {
    const prefix = `${this.base()}/`;
    return url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : null;
  }
}
