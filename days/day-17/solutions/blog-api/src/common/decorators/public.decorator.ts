import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// 标注「无需登录」的路由
// 全局 AuthGuard 默认拦截所有请求，只有打了 @Public() 的才放行
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
