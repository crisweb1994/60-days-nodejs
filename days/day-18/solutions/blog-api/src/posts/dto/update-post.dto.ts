import { PartialType } from '@nestjs/mapped-types';
import { CreatePostDto } from './create-post.dto';

// PartialType 在运行时复制 CreatePostDto 的元数据，再把所有字段标成 @IsOptional()
// 这样校验规则只维护一份，避免 update/create 字段定义漂移
export class UpdatePostDto extends PartialType(CreatePostDto) {}
