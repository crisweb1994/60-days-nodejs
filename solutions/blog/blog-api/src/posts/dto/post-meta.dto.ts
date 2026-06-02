import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

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
}
