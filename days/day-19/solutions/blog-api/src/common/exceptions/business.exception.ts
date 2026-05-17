import { HttpException, HttpStatus } from '@nestjs/common';

// 用一个统一的 BusinessException + 业务码表，避免给每种错误写一个子类
// HTTP 状态表达"哪类问题"，code 表达"具体哪个问题"
export class BusinessException extends HttpException {
  constructor(
    public readonly bizCode: string,
    message: string,
    httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    // response 对象会被 Filter 通过 getResponse() 取出
    // 把 code/message 放在这里，Filter 不需要任何业务分支就能透传
    super({ code: bizCode, message }, httpStatus);
  }
}

// 集中维护业务码，方便和前端对齐
export const BizCode = {
  SLUG_TAKEN: 'SLUG_TAKEN',
  POST_ARCHIVED: 'POST_ARCHIVED',
} as const;
