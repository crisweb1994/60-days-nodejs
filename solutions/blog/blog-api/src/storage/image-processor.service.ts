import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharpImport from 'sharp';
import type { AppConfig } from '../config/configuration';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { HttpStatus } from '@nestjs/common';
import { MIME_TO_EXT } from './storage.constants';

// sharp 的类型声明是 `export default sharp`，但运行时是 CJS `module.exports = sharp`（没有 .default）。
// 本项目 tsconfig 没开 esModuleInterop，`import sharp from 'sharp'` 类型能过、运行时却是 undefined
// （`sharp_1.default is not a function`）。用 namespace import 拿到「函数本身」——和 multer 同一个坑。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp = (sharpImport as any).default ?? (sharpImport as any);

/** 处理后的图：新的字节流 + 元信息。 */
export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
  format: string;
}

/**
 * ImageProcessorService —— 用 sharp 对上传图片做「核验 + 归一化」。
 *
 * 两件事，缺一不可：
 *
 * 1. **核验这是真的图**（不是被改了扩展名 / 改了 Content-Type 的别的文件）。
 *    只看 Content-Type / 扩展名是经典漏洞：攻击者把 a.php 改名 a.jpg、或把恶意脚本
 *    顶个 image/jpeg 头上传。sharp 读取时会解析真实像素结构——解析不出 width/height
 *    就不是合法图，直接拒。这一步把「信任浏览器报的 MIME」换成「信任文件真实字节」。
 *
 * 2. **归一化**：统一缩放到最大宽度、转成目标格式（默认 webp，体积/质量比 jpeg 更优）。
 *    好处：省带宽与存储；杜绝「上传 8000×8000 的图把列表页撑爆」；EXIF 自动旋正（手机竖拍不倒）。
 *
 * ★ 这一步在前端【不能省、但也不能只靠前端】：浏览器校验只是体验优化，绕过它直发
 *   multipart 的成本几乎为零。后端必须自己核验（纵深防御）。
 */
@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async processCover(buffer: Buffer): Promise<ProcessedImage> {
    // ① 读真实元信息——解析失败 = 不是图。
    const meta = await sharp(buffer).metadata().catch(() => null);
    if (!meta || !meta.width || !meta.height) {
      throw new BusinessException(
        ErrorCodes.INVALID_FILE,
        '文件不是合法的图片，或已损坏',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const maxWidth = this.config.get('storage.cover.maxWidth', { infer: true });
    const format = this.config.get('storage.cover.format', { infer: true });

    // ② 归一化：自动按 EXIF 旋正 → 限制最大宽（不放大）→ 转目标格式。
    const { data, info } = await sharp(buffer)
      .rotate() // 0 参数 = 按 EXIF Orientation 自动旋正
      .resize({ width: maxWidth, withoutEnlargement: true }) // 小图不放大
      .toFormat(format, { quality: 82 }) // 82 是 webp/jpeg 质量/体积的常见甜点
      .toBuffer({ resolveWithObject: true });

    const contentType = `image/${info.format}`;
    const ext = MIME_TO_EXT[contentType] ?? info.format;
    this.logger.debug(
      `封面处理：${meta.width}×${meta.height} ${meta.format} → ${info.width}×${info.height} ${info.format} (${buffer.length}→${data.length}B)`,
    );
    return {
      buffer: data,
      contentType,
      ext,
      width: info.width,
      height: info.height,
      format: info.format,
    };
  }
}
