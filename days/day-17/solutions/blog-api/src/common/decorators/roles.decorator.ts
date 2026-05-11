import { SetMetadata } from '@nestjs/common';

// 自定义元数据 key（用常量而不是字符串，避免 Reflector 读取时拼错）
export const ROLES_KEY = 'roles';

// @Roles('admin', 'editor') → 给 handler/Controller 写入元数据
// 配合 RolesGuard 使用：Guard 用 Reflector 读这条元数据来决定是否放行
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
