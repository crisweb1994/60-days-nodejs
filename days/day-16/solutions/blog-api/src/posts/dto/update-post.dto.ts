import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

// 这里手写所有可选字段，避免引入 @nestjs/mapped-types 依赖
// 后续可改为：export class UpdatePostDto extends PartialType(CreatePostDto) {}
export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50_000)
  content?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  author?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
