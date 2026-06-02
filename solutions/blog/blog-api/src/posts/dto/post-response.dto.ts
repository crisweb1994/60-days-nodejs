import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { POST_STATUSES, type PostStatus } from '../entities/post.entity';
import { PostMetaDto } from './post-meta.dto';

// ============================================================================
// 仅用于 OpenAPI 文档的响应模型（不参与运行时校验，从不被 new）。
// 和领域 Post 接口刻意分开：文档模型描述"线上 JSON 长什么样"，领域模型描述"业务对象"。
// createdAt/updatedAt 在 JSON 里是 ISO 字符串（Date 被序列化），所以这里标 string。
// ============================================================================

export class PostResponseDto {
  @ApiProperty({ format: 'uuid', example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })
  id!: string;

  @ApiProperty({ example: 'NestJS + Prisma 实战' })
  title!: string;

  @ApiProperty({ example: 'nestjs-prisma-in-action' })
  slug!: string;

  @ApiProperty({ example: '正文……（至少 10 个字符）' })
  content!: string;

  @ApiProperty({ type: [String], example: ['nestjs', 'prisma'] })
  tags!: string[];

  @ApiProperty({ enum: POST_STATUSES, example: 'published' })
  status!: PostStatus;

  @ApiPropertyOptional({ type: () => PostMetaDto })
  meta?: PostMetaDto;

  @ApiProperty({ example: 3, description: '乐观锁版本号，每次更新自增（Day 29）' })
  version!: number;

  @ApiProperty({ example: 42, description: '浏览次数（原子自增）' })
  viewCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PostRevisionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty({ example: 2, description: '该快照对应的文章版本号' })
  version!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class PaginationDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 137 })
  total!: number;
}

export class PageInfoDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'eyJ2IjoiMjAyNi0wNi0wMSIsImlkIjoiLi4uIn0',
    description: '下一页游标；null 表示已到末尾',
  })
  nextCursor!: string | null;

  @ApiProperty({ example: true })
  hasMore!: boolean;

  @ApiProperty({ example: 20 })
  limit!: number;
}

// offset 列表（GET /posts）和搜索（GET /posts/search）的 data 形状
export class PostListResponseDto {
  @ApiProperty({ type: [PostResponseDto] })
  items!: PostResponseDto[];

  @ApiProperty({ type: PaginationDto })
  pagination!: PaginationDto;
}

// 游标列表（GET /posts/feed）的 data 形状
export class PostFeedResponseDto {
  @ApiProperty({ type: [PostResponseDto] })
  items!: PostResponseDto[];

  @ApiProperty({ type: PageInfoDto })
  pageInfo!: PageInfoDto;
}

// DELETE /posts/:id 的 data 形状
export class DeletedResponseDto {
  @ApiProperty({ example: true })
  deleted!: boolean;

  @ApiProperty({ format: 'uuid' })
  id!: string;
}
