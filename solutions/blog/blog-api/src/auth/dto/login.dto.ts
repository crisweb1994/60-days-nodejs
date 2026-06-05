import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ format: 'email', example: 'alice@example.com' })
  @IsEmail()
  email!: string;

  // 登录密码不做长度/格式校验：规则可能随时间变，老用户的旧密码不该被新规则卡住
  @ApiProperty({ example: 'S3cure-pass' })
  @IsString()
  password!: string;
}
