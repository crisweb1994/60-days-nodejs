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
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard, type JwtPayload } from '../auth/guards/jwt-auth.guard';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
} from '../common/decorators/api-envelope.decorator';
import { BusinessExceptionFilter } from '../common/filters/business-exception.filter';
import { CoverUploadInterceptor } from '../storage/cover-upload.interceptor';
import { CreatePostDto } from './dto/create-post.dto';
import {
  DeletedResponseDto,
  PostFeedResponseDto,
  PostListResponseDto,
  PostResponseDto,
  PostRevisionResponseDto,
} from './dto/post-response.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { SearchPostDto } from './dto/search-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { PostsService } from './posts.service';

// 路径参数 :id 的统一文档
const idParam = ApiParam({
  name: 'id',
  format: 'uuid',
  description: '文章 UUID（v4）',
});

// 控制器级 filter：精确匹配 BusinessException → 该 filter 接管
// 其他异常（Error / 其它 HttpException）冒泡到全局 AllExceptionsFilter
@ApiTags('posts')
@UseFilters(BusinessExceptionFilter)
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // ── 读接口：公开，无需登录 ────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '列表（offset 分页 + 过滤 + 排序）' })
  @ApiEnvelope(PostListResponseDto)
  findAll(@Query() query: QueryPostDto) {
    return this.posts.findAll(query);
  }

  // Day 28：游标分页。和下面的 search / debug 一样，静态路径必须放在 :id 前面，
  // 否则 'feed' 会被当成 :id 交给 ParseUUIDPipe → 400。
  @Get('feed')
  @ApiOperation({ summary: '信息流（cursor 分页）' })
  @ApiEnvelope(PostFeedResponseDto)
  @ApiErrorEnvelope(400, 'cursor 参数非法', 'VALIDATION_ERROR')
  feed(@Query() query: QueryPostDto) {
    return this.posts.feed(query);
  }

  // Day 28：全文搜索
  @Get('search')
  @ApiOperation({ summary: '全文搜索（相关度排序）' })
  @ApiEnvelope(PostListResponseDto)
  search(@Query() query: SearchPostDto) {
    return this.posts.search(query);
  }

  // Day 37：热门文章排行榜（Sorted Set）。Redis ZSET 不可用时自动回退到 DB 按 view_count。
  // ★ 静态路径，必须放在 :id 前面，否则 'trending' 会被 ParseUUIDPipe 当成 id → 400。
  @Get('trending')
  @ApiOperation({ summary: '热门文章排行榜（按浏览数，ZSET 加速，DB 兜底）' })
  @ApiEnvelope(PostListResponseDto)
  trending(@Query('limit') rawLimit?: string) {
    // query string 一律是字符串：解析 + 钳制到 [1, 50]，非法值退回默认 10。
    const n = Number(rawLimit);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 50) : 10;
    return this.posts.trending(limit);
  }

  // 故意放在 :id 前面，避免 'debug' 被 ParseUUIDPipe 当成参数尝试解析
  @Get('debug/boom')
  @ApiExcludeEndpoint() // 调试端点，不进对外文档
  boom() {
    return this.posts.triggerBoom();
  }

  // ParseUUIDPipe 校验路径参数格式，非法 UUID 直接 400，不会进 Service
  @Get(':id')
  @ApiOperation({ summary: '按 id 查单篇' })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiErrorEnvelope(404, '文章不存在', 'POST_NOT_FOUND')
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.posts.findOne(id);
  }

  // Day 29：文章修订历史（新 → 旧）
  @Get(':id/revisions')
  @ApiOperation({ summary: '修订历史（新 → 旧）' })
  @idParam
  @ApiEnvelope(PostRevisionResponseDto, { isArray: true })
  @ApiErrorEnvelope(404, '文章不存在', 'POST_NOT_FOUND')
  revisions(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.posts.listRevisions(id);
  }

  // Day 29：浏览计数 +1（原子自增，无需锁）。公开——匿名访客也能贡献浏览数。
  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '浏览计数 +1（原子自增）' })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiErrorEnvelope(404, '文章不存在', 'POST_NOT_FOUND')
  incrementView(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.posts.incrementView(id);
  }

  // Day 39：上传封面图。multipart/form-data，字段名 file；multer 在 CoverUploadInterceptor 里解析。
  // @UseInterceptors 的拦截器经 DI 实例化——它注入 ConfigService 拿到配置驱动的 limits / fileFilter。
  // ★ @HttpCode(200)：这是【更新】已有文章的封面，不是创建资源，所以不该用 @Post 默认的 201。
  @Post(':id/cover')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(CoverUploadInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: '上传封面图（需登录 + 作者本人或 admin）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiErrorEnvelope(400, '未上传文件 / 非图片', 'INVALID_FILE')
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  @ApiErrorEnvelope(403, '不是作者也不是 admin', 'FORBIDDEN')
  @ApiErrorEnvelope(404, '文章不存在', 'POST_NOT_FOUND')
  @ApiErrorEnvelope(413, '文件过大', 'UPLOAD_TOO_LARGE')
  @ApiErrorEnvelope(415, '仅支持图片', 'UNSUPPORTED_MEDIA_TYPE')
  uploadCover(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.posts.uploadCover(id, file, user);
  }

  // ── 写接口：Day 33 起需要登录；改 / 删还要是作者本人或 admin ──────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建文章（需登录，作者=当前用户）' })
  @ApiEnvelope(PostResponseDto, { status: 201, description: '创建成功' })
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  @ApiErrorEnvelope(409, 'slug 已被占用', 'SLUG_TAKEN')
  create(@Body() dto: CreatePostDto, @CurrentUser() user: JwtPayload) {
    return this.posts.create(dto, user.sub);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '局部更新（需登录 + 作者本人或 admin）',
    description: '带 `version` 即做乐观锁；不带则 last-write-wins。每次成功更新自增 version 并留一条修订。',
  })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  @ApiErrorEnvelope(403, '不是作者也不是 admin', 'FORBIDDEN')
  @ApiErrorEnvelope(409, 'slug 占用 / 已归档 / 版本冲突', 'VERSION_CONFLICT')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.posts.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除文章（需登录 + 作者本人或 admin）' })
  @idParam
  @ApiEnvelope(DeletedResponseDto)
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  @ApiErrorEnvelope(403, '不是作者也不是 admin', 'FORBIDDEN')
  @ApiErrorEnvelope(404, '文章不存在', 'POST_NOT_FOUND')
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.posts.remove(id, user);
  }
}
