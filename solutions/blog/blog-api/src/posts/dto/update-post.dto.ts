import { PartialType } from '@nestjs/mapped-types';
import { IsInt, IsOptional, Min } from 'class-validator';
import { CreatePostDto } from './create-post.dto';

// PartialType 在运行时复制 CreatePostDto 的元数据，再把所有字段标成 @IsOptional()
// 这样校验规则只维护一份，避免 update/create 字段定义漂移
export class UpdatePostDto extends PartialType(CreatePostDto) {
  // Day 29：乐观锁期望版本号（可选）。带上它 → 服务端用 WHERE version=? 检测并发修改，
  // 不一致返回 409 VERSION_CONFLICT；不带 → last-write-wins（向后兼容不做并发控制的客户端）。
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
