import { SetMetadata } from '@nestjs/common';

// 把"这个路由需要哪些角色"作为元数据挂到 handler 上，RolesGuard 再用 Reflector 读出来。
// 用法：@Roles('admin')  /  @Roles('admin', 'editor')
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
