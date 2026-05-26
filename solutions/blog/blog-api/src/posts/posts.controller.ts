import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import { BusinessExceptionFilter } from '../common/filters/business-exception.filter';
import { CreatePostDto } from './dto/create-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { PostsService } from './posts.service';

// 控制器级 filter：精确匹配 BusinessException → 该 filter 接管
// 其他异常（Error / 其它 HttpException）冒泡到全局 AllExceptionsFilter
@UseFilters(BusinessExceptionFilter)
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  findAll(@Query() query: QueryPostDto) {
    return this.posts.findAll(query);
  }

  // 故意放在 :id 前面，避免 'debug' 被 ParseUUIDPipe 当成参数尝试解析
  @Get('debug/boom')
  boom() {
    return this.posts.triggerBoom();
  }

  // ParseUUIDPipe 校验路径参数格式，非法 UUID 直接 400，不会进 Service
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.posts.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePostDto) {
    return this.posts.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.posts.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.posts.remove(id);
  }
}
