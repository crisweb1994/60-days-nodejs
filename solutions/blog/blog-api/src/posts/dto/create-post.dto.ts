import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'NestJS + Prisma 实战' })
  @IsString()
  @Length(1, 100, { message: 'title 长度需在 1-100' })
  title!: string;

  // 自定义校验器：练习 2
  @ApiProperty({
    description: '小写字母 / 数字 / 连字符，最长 80',
    example: 'nestjs-prisma-in-action',
  })
  @IsSlug()
  slug!: string;

  @ApiProperty({ minLength: 10, example: '正文至少 10 个字符……' })
  @IsString()
  @MinLength(10, { message: 'content 至少 10 个字符' })
  content!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 10,
    description: '每项 1-20 字符，最多 10 项',
    example: ['nestjs', 'prisma'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 20, { each: true })
  tags?: string[];

  @ApiProperty({ enum: POST_STATUSES, example: 'draft' })
  @IsEnum(POST_STATUSES, { message: `status 必须是 ${POST_STATUSES.join(' / ')}` })
  status!: PostStatus;

  // 嵌套 DTO：练习 3
  // 注意：@Type() 必须存在，否则 @ValidateNested() 会"静默失效"
  @ApiPropertyOptional({ type: () => PostMetaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PostMetaDto)
  meta?: PostMetaDto;
}
