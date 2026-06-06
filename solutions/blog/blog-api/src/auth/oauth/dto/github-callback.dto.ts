import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// GitHub 回调带的 query。成功是 code + state；用户拒绝授权则是 error + error_description。
// 都设可选、在 handler 里判，因为两种情况二选一。
export class GithubCallbackDto {
  @ApiPropertyOptional({ description: '授权码' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: '防 CSRF 的 state，须与发起时一致' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: '用户拒绝授权时 GitHub 会带 error' })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  error_description?: string;
}
