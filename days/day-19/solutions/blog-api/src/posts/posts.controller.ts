import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
// 其他异常（NotFoundException / Error / ...）冒泡到全局 AllExceptionsFilter
@UseFilters(BusinessExceptionFilter)
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  findAll(@Query() query: QueryPostDto) {
    return this.posts.findAll(query);
  }

  // 故意放在 :id 前面，避免 'debug' 被 ParseIntPipe 误吃
  @Get('debug/boom')
  boom() {
    return this.posts.triggerBoom();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.posts.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePostDto) {
    return this.posts.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePostDto) {
    return this.posts.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.posts.remove(id);
  }
}
