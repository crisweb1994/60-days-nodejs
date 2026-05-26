import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '../constants/error-codes';

// 业务异常基类：HTTP 状态表达"哪类问题"，bizCode 表达"具体哪个问题"
// 用一个统一的 BusinessException + 业务码表，避免给每种业务错误写一个子类
export class BusinessException extends HttpException {
  constructor(
    public readonly bizCode: ErrorCode,
    message: string,
    httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    // response 对象会被 Filter 通过 getResponse() 取出
    // Filter 不需要任何业务分支，直接透传 { code, message }
    super({ code: bizCode, message }, httpStatus);
  }
}
