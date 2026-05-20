import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { InMemoryPostsRepository } from './repositories/in-memory-posts.repository';
import { POSTS_REPOSITORY } from './repositories/posts.repository';

@Module({
  controllers: [PostsController],
  providers: [
    PostsService,
    // Day 20: 用内存实现。Day 21 只需把 useClass 换成 PrismaPostsRepository，
    // Service / Controller / DTO / Filter 一行不用改
    { provide: POSTS_REPOSITORY, useClass: InMemoryPostsRepository },
    // 同时把实现类自身也注册一份，方便测试里 app.get(InMemoryPostsRepository).clear()
    InMemoryPostsRepository,
  ],
})
export class PostsModule {}
