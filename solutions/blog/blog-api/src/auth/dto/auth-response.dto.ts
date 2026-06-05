import { ApiProperty } from '@nestjs/swagger';

// 对外的用户视图——**永远不含 password**
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ example: 'alice' })
  username!: string;

  @ApiProperty({ example: 'user', description: 'Day 33 RBAC 会用到' })
  role!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT access token，放进 Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ description: '不透明 refresh token，用来换新的 access（请安全保存）' })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'access token 存活秒数' })
  expiresIn!: number;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;
}
