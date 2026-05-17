import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PostStatus } from '../entities/post.entity';

export class QueryPostDto {
  // enableImplicitConversion 把 query string 自动转 number
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsEnum(['draft', 'published', 'archived'])
  status?: PostStatus;
}
