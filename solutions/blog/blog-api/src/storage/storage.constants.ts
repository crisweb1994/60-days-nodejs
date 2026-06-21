// 存储层的 DI token 和共享常量。

// DI token：用 Symbol（和 POSTS_REPOSITORY 同款），避免和字符串 token 撞名。
// 注入方写 @Inject(STORAGE_SERVICE) storage: StorageService。
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

// 封面图允许的 MIME 白名单。multer 的 fileFilter 在「缓冲开始前」按它早拦截，
// ImageProcessor 还会用 sharp 二次核验「这真的是个图」——两层各挡一种伪造（改扩展名 / 改 Content-Type）。
// ★ 故意不收 image/svg+xml：SVG 能内嵌 <script>，前端 <img src> 渲染它是 XSS 面；光栅图没这风险。
export const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

// MIME → 扩展名 / sharp 目标格式的映射，落 key 时给文件起后缀用。
export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
