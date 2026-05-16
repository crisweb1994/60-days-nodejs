import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class CreatePostDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 50_000)
  content!: string;

  @IsString()
  @Length(1, 50)
  author!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
