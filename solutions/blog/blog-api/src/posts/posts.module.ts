import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PrismaPostsRepository } from './repositories/prisma-posts.repository';
import { POSTS_REPOSITORY } from './repositories/posts.repository';
import { TrendingService } from './trending.service';

@Module({
  // PrismaModule 是 @Global，其实不 import 也能注入 PrismaService；这里显式写出来。
  // Day 33：import AuthModule —— 它导出了 JwtAuthGuard，写接口 @UseGuards(JwtAuthGuard) 才能解析。
  // Day 37：TrendingService 只依赖 RedisService（@Global），在 providers 里声明即可注入给 PostsService。
  imports: [PrismaModule, AuthModule],
  controllers: [PostsController],
  providers: [
    PostsService,
    TrendingService,
    // Day 27：从 InMemoryPostsRepository 换成 PrismaPostsRepository——
    // 这就是 Day 20 埋下的伏笔，整个切换只动这一行 useClass。
    // Service / Controller / DTO / Filter 一行未改，因为它们只依赖 PostsRepository 接口。
    //   想切回内存版（比如临时演示）：把 InMemoryPostsRepository import 回来，
    //   再把下面这行的 useClass 换成它即可（类文件仍保留在 repositories/ 下）。
    { provide: POSTS_REPOSITORY, useClass: PrismaPostsRepository },
  ],
})
export class PostsModule {}
