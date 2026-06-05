import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

// /auth/refresh 和 /auth/logout 共用：都只需要一个 refreshToken
export class RefreshDto {
  @ApiProperty({ description: '登录 / 刷新返回的 refreshToken' })
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}
