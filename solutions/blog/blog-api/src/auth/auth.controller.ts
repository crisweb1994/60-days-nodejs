import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ErrorCodes } from '../common/constants/error-codes';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
} from '../common/decorators/api-envelope.decorator';
import { BusinessException } from '../common/exceptions/business.exception';
import { BusinessExceptionFilter } from '../common/filters/business-exception.filter';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import {
  AuthResponseDto,
  LogoutResponseDto,
  UserResponseDto,
} from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard, type JwtPayload } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { GithubCallbackDto } from './oauth/dto/github-callback.dto';
import { GithubOAuthProvider } from './oauth/github-oauth.provider';
import { OAuthStateStore } from './oauth/oauth-state.store';

// 和 PostsController 一样挂 BusinessExceptionFilter：让 Service / Guard 抛的 BusinessException
// 走统一错误外壳（含 category:'business'）。Guard 抛的异常也会被这个 filter 接住。
// Day 35：认证接口是暴力破解 / 撞库的主战场，比全局默认（1000/分钟）紧得多——
// 每 IP 每分钟最多 30 次覆盖注册 / 登录 / 刷新 / 登出 / OAuth。正常用户单次会话远到不了这个量。
// 真要对抗分布式撞库，单机限流不够，得在网关 / Redis 上做（Day 36 起）。
@Throttle({ default: { limit: 30, ttl: 60000 } })
@ApiTags('auth')
@UseFilters(BusinessExceptionFilter)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly github: GithubOAuthProvider,
    private readonly stateStore: OAuthStateStore,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '注册（bcrypt 哈希密码，返回 access + refresh）' })
  @ApiEnvelope(AuthResponseDto, { status: 201 })
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiErrorEnvelope(409, '邮箱 / 用户名已占用', 'EMAIL_TAKEN')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录' })
  @ApiEnvelope(AuthResponseDto)
  @ApiErrorEnvelope(401, '邮箱或密码错误', 'INVALID_CREDENTIALS')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用 refresh 换新 access（轮换：旧 refresh 立即作废）' })
  @ApiEnvelope(AuthResponseDto)
  @ApiErrorEnvelope(401, 'refresh token 无效或已过期', 'INVALID_REFRESH_TOKEN')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登出（作废该 refresh token，幂等）' })
  @ApiEnvelope(LogoutResponseDto)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '当前登录用户（需 Bearer access token）' })
  @ApiEnvelope(UserResponseDto)
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user.sub);
  }

  // ───────────────── Day 34：GitHub OAuth（授权码模式）─────────────────
  // 第一步：浏览器访问本接口 → 我们生成 state（防 CSRF）并 302 跳到 GitHub 授权页。
  // 用 @Res() 直接发 302：这是少数手动控制响应的场景，不走统一 envelope。
  @Get('github')
  @ApiOperation({ summary: '发起 GitHub 登录（302 跳到 GitHub 授权页）' })
  githubLogin(@Res() res: Response) {
    if (!this.github.isConfigured()) {
      // 没配 client id/secret：明确回 503，而不是跳一个一定会失败的 URL
      throw new BusinessException(
        ErrorCodes.OAUTH_NOT_CONFIGURED,
        '本服务未配置 GitHub OAuth',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const state = this.stateStore.generate();
    res.redirect(this.github.getAuthorizeUrl(state));
  }

  // 第二步：GitHub 同意后带 code + state 回调到这里。
  // 校验 state → 拿 code 换 GitHub token → 拉用户资料 → 在本系统登录/建号 → 发我们自己的 token。
  @Get('github/callback')
  @ApiOperation({ summary: 'GitHub 回调：校验 state → 换 token → 发本系统 token' })
  @ApiEnvelope(AuthResponseDto)
  @ApiErrorEnvelope(401, 'state 失效或授权失败', 'OAUTH_STATE_INVALID')
  async githubCallback(@Query() query: GithubCallbackDto) {
    if (query.error) {
      // 用户在 GitHub 点了"拒绝"
      throw new BusinessException(
        ErrorCodes.OAUTH_FAILED,
        `GitHub 授权被拒绝：${query.error_description ?? query.error}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    // state 必须存在、未用过、未过期——consume 是一次性的，挡住 CSRF 和重复回调
    if (!query.code || !query.state || !this.stateStore.consume(query.state)) {
      throw new BusinessException(
        ErrorCodes.OAUTH_STATE_INVALID,
        'state 无效或已过期（可能是 CSRF 或重复回调）',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const githubToken = await this.github.exchangeCodeForToken(query.code);
    const ghUser = await this.github.fetchGithubUser(githubToken);
    return this.auth.loginWithGithub(ghUser);
  }

  // Day 33：纯 RBAC 示例——先 JwtAuthGuard 认证，再 RolesGuard 校验角色（顺序不能反）
  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: '列出所有用户（仅 admin）' })
  @ApiEnvelope(UserResponseDto, { isArray: true })
  @ApiErrorEnvelope(401, '未认证', 'UNAUTHORIZED')
  @ApiErrorEnvelope(403, '权限不足', 'FORBIDDEN')
  listUsers() {
    return this.auth.listUsers();
  }
}
