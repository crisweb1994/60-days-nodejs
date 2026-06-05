import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ format: 'email', maxLength: 255, example: 'alice@example.com' })
  @IsEmail({}, { message: 'email 格式不正确' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 50,
    description: '只能含字母 / 数字 / 下划线 / 连字符',
    example: 'alice',
  })
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'username 只能含字母/数字/下划线/连字符' })
  username!: string;

  @ApiProperty({ minLength: 8, maxLength: 100, example: 'S3cure-pass' })
  @IsString()
  @MinLength(8, { message: 'password 至少 8 个字符' })
  @MaxLength(100)
  password!: string;
}
