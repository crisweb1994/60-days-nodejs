import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import { CreatePostDto } from './create-post.dto';

// ★ PartialType 从 @nestjs/swagger 引入（不是 @nestjs/mapped-types）：它既把 CreatePostDto
//   的字段变可选（连同 class-validator 规则），又**保留 @ApiProperty 元数据**，所以
//   update 的 Swagger 文档自动复用 create 的字段定义，一处维护、两处生效。
export class UpdatePostDto extends PartialType(CreatePostDto) {
  // Day 29：乐观锁期望版本号（可选）。带上它 → 服务端用 WHERE version=? 检测并发修改，
  // 不一致返回 409 VERSION_CONFLICT；不带 → last-write-wins（向后兼容不做并发控制的客户端）。
  @ApiPropertyOptional({
    minimum: 1,
    description: '乐观锁期望版本号；与当前不一致返回 409 VERSION_CONFLICT',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
