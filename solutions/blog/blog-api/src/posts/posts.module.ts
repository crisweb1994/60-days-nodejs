import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PrismaPostsRepository } from './repositories/prisma-posts.repository';
import { POSTS_REPOSITORY } from './repositories/posts.repository';

@Module({
  // PrismaModule 是 @Global，其实不 import 也能注入 PrismaService；
  // 这里显式写出来，是为了让"PostsModule 依赖数据库"这件事在模块层面可见。
  imports: [PrismaModule],
  controllers: [PostsController],
  providers: [
    PostsService,
    // Day 27：从 InMemoryPostsRepository 换成 PrismaPostsRepository——
    // 这就是 Day 20 埋下的伏笔，整个切换只动这一行 useClass。
    // Service / Controller / DTO / Filter 一行未改，因为它们只依赖 PostsRepository 接口。
    //   想切回内存版（比如临时演示）：把 InMemoryPostsRepository import 回来，
    //   再把下面这行的 useClass 换成它即可（类文件仍保留在 repositories/ 下）。
    { provide: POSTS_REPOSITORY, useClass: PrismaPostsRepository },
  ],
})
export class PostsModule {}
