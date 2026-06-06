import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfig } from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { GithubOAuthProvider } from './oauth/github-oauth.provider';
import { OAuthStateStore } from './oauth/oauth-state.store';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    // PrismaModule 虽是 @Global，这里显式 import：别依赖"PostsModule 恰好也 import 了它"
    PrismaModule,
    // JwtModule 用配置里的 access secret + TTL（秒）。secret 是 access token 的信任根。
    // registerAsync + inject ConfigService：等 env 校验通过后再拿值。
    // ★ 显式 pin HS256：签发 + 验证都固定算法，不看 token header 里的 alg——
    //   从根上堵死 Day 31 §6 说的 alg:none / 算法混淆，且不依赖库的默认行为。
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get('auth.accessSecret', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.get('auth.accessTtl', { infer: true }),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  // PrismaService 由全局 PrismaModule 提供，这里直接注入
  // Day 34：GithubOAuthProvider（打 GitHub 的 HTTP）+ OAuthStateStore（state 防 CSRF）
  providers: [
    AuthService,
    TokensService,
    JwtAuthGuard,
    RolesGuard,
    GithubOAuthProvider,
    OAuthStateStore,
  ],
  // ★ 关键：导出 JwtModule（连带 JwtService）。@UseGuards(JwtAuthGuard) 是在**控制器所在
  //   模块**里实例化守卫的——PostsController 用它时，Nest 在 PostsModule 上下文重建守卫，
  //   需要 JwtService 在那边可解析。只导出守卫类不够，必须把 JwtModule 也 re-export 出去。
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
