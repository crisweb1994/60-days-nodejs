import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { POST_STATUSES, type PostStatus } from '../entities/post.entity';

// sortBy 字段必须白名单校验：直接拼到未来的 SQL ORDER BY 就是注入入口
const SORT_FIELDS = ['createdAt', 'updatedAt', 'title'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export class QueryPostDto {
  // enableImplicitConversion 把 query string 自动转 number
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  // limit 必须有上限。没有上限的接口等同于 DoS 入口：?limit=10000000 直接打爆内存
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(SORT_FIELDS)
  sortBy?: SortField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsEnum(POST_STATUSES)
  status?: PostStatus;
}
