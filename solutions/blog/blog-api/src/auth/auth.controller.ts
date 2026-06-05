import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
} from '../common/decorators/api-envelope.decorator';
import { BusinessExceptionFilter } from '../common/filters/business-exception.filter';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  AuthResponseDto,
  LogoutResponseDto,
  UserResponseDto,
} from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard, type JwtPayload } from './guards/jwt-auth.guard';

// 和 PostsController 一样挂 BusinessExceptionFilter：让 Service / Guard 抛的 BusinessException
// 走统一错误外壳（含 category:'business'）。Guard 抛的异常也会被这个 filter 接住。
@ApiTags('auth')
@UseFilters(BusinessExceptionFilter)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
}
