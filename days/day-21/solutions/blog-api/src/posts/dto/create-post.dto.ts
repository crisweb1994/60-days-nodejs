import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsSlug } from '../../common/validators/is-slug.validator';
import { POST_STATUSES, type PostStatus } from '../entities/post.entity';
import { PostMetaDto } from './post-meta.dto';

export class CreatePostDto {
  @IsString()
  @Length(1, 100, { message: 'title 长度需在 1-100' })
  title!: string;

  // 自定义校验器：练习 2
  @IsSlug()
  slug!: string;

  @IsString()
  @MinLength(10, { message: 'content 至少 10 个字符' })
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 20, { each: true })
  tags?: string[];

  @IsEnum(POST_STATUSES, { message: `status 必须是 ${POST_STATUSES.join(' / ')}` })
  status!: PostStatus;

  // 嵌套 DTO：练习 3
  // 注意：@Type() 必须存在，否则 @ValidateNested() 会"静默失效"
  @IsOptional()
  @ValidateNested()
  @Type(() => PostMetaDto)
  meta?: PostMetaDto;
}
