import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { POST_STATUSES, type PostStatus } from '../entities/post.entity';

// 全文搜索的查询参数。和 QueryPostDto（浏览列表）分开：
// 搜索是另一种访问模式——有相关性排序、按相关度返回，不需要按时间/标题排序那套。
export class SearchPostDto {
  // q 必填：没有关键词就不是"搜索"。长度设上限，避免超长 tsquery 拖垮解析。
  // 先 trim 再校验：否则 q='   '（纯空格）能过 MinLength(1)，但既不是有效搜索词，
  // 还会让朴素实现把它当"空词集"匹配到全表。trim 后空串被 MinLength 挡成 400。
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description: '搜索词，按 websearch_to_tsquery 解析（支持 "短语"、or、-排除）',
    example: 'prisma 事务',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'q 不能为空' })
  @MaxLength(100)
  q!: string;

  // 搜索结果用 offset 分页就够：用户极少翻到搜索结果的第 50 页，
  // 且按相关度排序时 cursor 的"稳定排序键"不好定义。
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: POST_STATUSES })
  @IsOptional()
  @IsEnum(POST_STATUSES)
  status?: PostStatus;
}
