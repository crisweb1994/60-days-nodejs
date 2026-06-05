import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfig } from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
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
  providers: [AuthService, TokensService, JwtAuthGuard],
})
export class AuthModule {}
