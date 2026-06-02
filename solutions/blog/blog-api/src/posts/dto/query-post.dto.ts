import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { POST_STATUSES, type PostStatus } from '../entities/post.entity';

// sortBy 字段必须白名单校验：直接拼到未来的 SQL ORDER BY 就是注入入口
const SORT_FIELDS = ['createdAt', 'updatedAt', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export class QueryPostDto {
  // enableImplicitConversion 把 query string 自动转 number
  @ApiPropertyOptional({ minimum: 1, default: 1, description: 'offset 模式页码' })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  // limit 必须有上限。没有上限的接口等同于 DoS 入口：?limit=10000000 直接打爆内存
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(SORT_FIELDS)
  sortBy?: SortField;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ maxLength: 100, description: '模糊匹配 title / content（ILIKE）' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiPropertyOptional({ description: '按标签精确过滤' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ enum: POST_STATUSES })
  @IsOptional()
  @IsEnum(POST_STATUSES)
  status?: PostStatus;

  // Day 28：游标分页用的不透明 token。offset 模式（GET /posts）忽略它；
  // 游标模式（GET /posts/feed）用它定位"上一页最后一条"。长度设上限防超长输入。
  @ApiPropertyOptional({
    maxLength: 500,
    description: '游标分页 token（仅 /posts/feed 使用），原样回传上一页的 nextCursor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;
}
