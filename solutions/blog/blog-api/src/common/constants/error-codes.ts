// 错误码集中维护，避免在抛出点写裸字符串
// 改名字时一处出错全项目报错，比 grep 拼写错误安全得多
export const ErrorCodes = {
  // 通用
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // 文章
  POST_NOT_FOUND: 'POST_NOT_FOUND',
  SLUG_TAKEN: 'SLUG_TAKEN',
  POST_ARCHIVED: 'POST_ARCHIVED',
  // Day 29：乐观锁版本冲突（带 version 的更新撞上了别人的并发修改）
  VERSION_CONFLICT: 'VERSION_CONFLICT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
