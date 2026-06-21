import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as multer from 'multer';
import { MulterError } from 'multer';
import { Observable } from 'rxjs';
import type { AppConfig } from '../config/configuration';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { ALLOWED_IMAGE_MIME } from './storage.constants';

// 自定义 fileFilter 错误标识——和 MulterError 区分开（一个是 multer 的，一个是我们拦的）。
const ERR_UNSUPPORTED = 'UNSUPPORTED_IMAGE';

// multer 是 CJS（module.exports = 函数 + 挂 memoryStorage / diskStorage / MulterError）。
// 本项目 tsconfig 只开了 allowSyntheticDefaultImports（仅类型层）、没开 esModuleInterop，
// 所以 `import multer from 'multer'` 类型能过、运行时却是 undefined。改用 namespace import
// 拿到「函数本身」再断言成可调用类型——这是 CJS 库在不带 esModuleInterop 时的标准绕法。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multerFn = multer as any;

/**
 * CoverUploadInterceptor —— 用 multer 解析 multipart/form-data 里的单个 `file` 字段。
 *
 * 为什么不用 @UseInterceptors(FileInterceptor('file', options))：
 *   FileInterceptor 的 options 是【装饰器参数】，在类定义时（import 阶段）就要求值——
 *   那时还没法注入 ConfigService，拿不到 env 里的 UPLOAD_MAX_BYTES。
 *   要「配置驱动」的 limits / fileFilter，标准做法是写一个 NestInterceptor，
 *   在里面用注入进来的 config 现场构造 multer 实例。本拦截器就是这个。
 *
 * 两个职责：
 *   1. limits.fileSize —— 硬上限：超了 multer 在【缓冲阶段】就中断，不会把整坨大文件读进内存。
 *   2. fileFilter —— 早拦截：Content-Type 不在图片白名单直接拒，免得白做后续处理。
 *
 * multer 抛错 / fileFilter 拒绝都在这里【翻译成 BusinessException】：
 *   LIMIT_FILE_SIZE → 413 UPLOAD_TOO_LARGE；其余 → 400/415。这样统一走全局错误外壳。
 */
@Injectable()
export class CoverUploadInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const upload = multerFn({
      storage: multerFn.memoryStorage(), // 先进内存，交给 ImageProcessor 处理完再落盘 / 传 S3
      limits: { fileSize: this.maxBytes },
      fileFilter: (_req: unknown, file: Express.Multer.File, cb: (err: unknown, ok?: boolean) => void) => {
        // Content-Type 是浏览器【自报】的——这里只做早拦截，真正的「是不是图」交给 sharp 二次核验。
        if (ALLOWED_IMAGE_MIME.has(file.mimetype)) cb(null, true);
        else cb(new Error(ERR_UNSUPPORTED));
      },
    }).single('file');

    return new Observable<unknown>((subscriber) => {
      upload(req, res, (err: unknown) => {
        if (err) {
          subscriber.error(this.toBizError(err));
          return;
        }
        next.handle().subscribe(subscriber);
      });
    });
  }

  /** 把 multer / fileFilter 的原始错误翻译成统一业务异常。 */
  private toBizError(err: unknown): BusinessException {
    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return new BusinessException(
        ErrorCodes.UPLOAD_TOO_LARGE,
        `文件过大，单文件上限 ${this.humanSize(this.maxBytes)}`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    if (err instanceof Error && err.message === ERR_UNSUPPORTED) {
      return new BusinessException(
        ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
        '仅支持 jpeg / png / webp / gif / avif 图片',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    return new BusinessException(
      ErrorCodes.VALIDATION_ERROR,
      (err as Error)?.message ?? '文件上传失败',
      HttpStatus.BAD_REQUEST,
    );
  }

  private get maxBytes(): number {
    return this.config.get('storage.upload.maxBytes', { infer: true });
  }

  /** 字节数转人类可读——测试用 1 KiB 上限时，别显示成「0 MiB」。 */
  private humanSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${bytes} B`;
  }
}
