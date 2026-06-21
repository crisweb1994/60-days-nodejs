import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

// 嵌套对象的 DTO：必须是 class，才能被 @Type() 实例化、被 @ValidateNested() 递归校验
export class PostMetaDto {
  @ApiProperty({ minLength: 1, maxLength: 70, example: 'NestJS + Prisma 实战 | 博客' })
  @IsString()
  @Length(1, 70, { message: 'seoTitle 长度需在 1-70' })
  seoTitle!: string;

  @ApiProperty({ minLength: 1, maxLength: 160, example: '手把手把内存版 API 接到 PostgreSQL……' })
  @IsString()
  @Length(1, 160, { message: 'seoDescription 长度需在 1-160' })
  seoDescription!: string;

  // Day 39：封面图 URL（可选）。正常由 POST /posts/:id/cover 落地；这里也允许通过 meta 显式设。
  // ★ 故意用 @IsString 而非 @IsUrl：本地后端产出的是 /uploads/... 相对 URL（无 host），
  //   @IsUrl 即便 require_protocol:false 也可能因「没有 host」误拒——而这正是我们自己发的格式。
  //   对一个服务端写、客户端只读的字段，宽松校验更稳妥。
  @ApiPropertyOptional({
    description: '封面图对外 URL（通常由上传接口设置）',
    example: '/uploads/covers/<id>/<uuid>.webp',
  })
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  coverImage?: string;
}
