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
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // 列表：公开
  @Public()
  @Get()
  findAll(@Query() query: QueryPostDto) {
    return this.posts.findAll(query);
  }

  // 注意：静态路由 'debug/boom' 必须放在动态路由 ':id' 前面，
  // 否则会被 :id 匹配到 → ParseIntPipe 把 'debug' 转 number 失败 → 400
  @Public()
  @Get('debug/boom')
  boom() {
    return this.posts.triggerBoom();
  }

  // 详情：公开
  @Public()
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.posts.findOne(id);
  }

  // 创建 / 更新：需要登录（AuthGuard 全局生效，无 @Public 即拦截）
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePostDto) {
    return this.posts.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePostDto,
  ) {
    return this.posts.update(id, dto);
  }

  // 删除：必须是 admin
  @Roles('admin')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.posts.remove(id);
  }
}
