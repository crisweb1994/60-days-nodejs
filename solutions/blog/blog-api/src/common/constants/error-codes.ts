// 错误码集中维护，避免在抛出点写裸字符串
// 改名字时一处出错全项目报错，比 grep 拼写错误安全得多
export const ErrorCodes = {
  // 通用
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Day 35：被限流（ThrottlerException 抛 429）。给个业务码，前端能和其它 4xx 一样走统一错误分支
  RATE_LIMITED: 'RATE_LIMITED',

  // 文章
  POST_NOT_FOUND: 'POST_NOT_FOUND',
  SLUG_TAKEN: 'SLUG_TAKEN',
  POST_ARCHIVED: 'POST_ARCHIVED',
  // Day 29：乐观锁版本冲突（带 version 的更新撞上了别人的并发修改）
  VERSION_CONFLICT: 'VERSION_CONFLICT',

  // Day 32：认证
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',

  // Day 34：OAuth
  OAUTH_NOT_CONFIGURED: 'OAUTH_NOT_CONFIGURED',
  OAUTH_STATE_INVALID: 'OAUTH_STATE_INVALID',
  OAUTH_FAILED: 'OAUTH_FAILED',

  // Day 39：文件上传与存储
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE', // 文件超过大小上限（multer limits.fileSize）
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE', // Content-Type 不在图片白名单
  INVALID_FILE: 'INVALID_FILE', // 不是合法图片（sharp 解析不出像素）/ 未上传文件
  STORAGE_FAILED: 'STORAGE_FAILED', // 对象存储读写失败（网络 / 权限 / 配置）

  // Day 40：安全加固版
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED', // 账号因连续登录失败被临时锁定（423 Locked）
  BODY_TOO_LARGE: 'BODY_TOO_LARGE', // 请求体超过体积上限（413 Payload Too Large）
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
