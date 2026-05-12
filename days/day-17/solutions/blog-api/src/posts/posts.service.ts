import { Injectable, NotFoundException } from '@nestjs/common';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { Post } from './entities/post.entity';

@Injectable()
export class PostsService {
  private posts: Post[] = [];
  private nextId = 1;

  // 内置几条样例，方便启动后直接试接口
  constructor() {
    this.create({
      title: 'Hello NestJS Pipeline',
      content: 'Middleware → Guard → Interceptor → Pipe → Handler → Filter',
      author: 'cris',
      tags: ['nestjs', 'lifecycle'],
      published: true,
    });
  }

  findAll(query: QueryPostDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    let list = this.posts;
    if (query.author) list = list.filter(p => p.author === query.author);
    if (query.tag) list = list.filter(p => p.tags.includes(query.tag!));

    const sorted = [...list].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const start = (page - 1) * limit;
    return {
      data: sorted.slice(start, start + limit),
      pagination: {
        page,
        limit,
        total: list.length,
        totalPages: Math.ceil(list.length / limit),
      },
    };
  }

  findOne(id: number) {
    const post = this.posts.find(p => p.id === id);
    if (!post) throw new NotFoundException(`Post #${id} not found`);
    return post;
  }

  create(dto: CreatePostDto): Post {
    const now = new Date();
    const post: Post = {
      id: this.nextId++,
      title: dto.title,
      content: dto.content,
      author: dto.author,
      tags: dto.tags ?? [],
      published: dto.published ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.posts.push(post);
    return post;
  }

  update(id: number, dto: UpdatePostDto) {
    const post = this.findOne(id);
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    Object.assign(post, changes, { updatedAt: new Date() });
    return post;
  }

  remove(id: number) {
    const idx = this.posts.findIndex(p => p.id === id);
    if (idx === -1) throw new NotFoundException(`Post #${id} not found`);
    this.posts.splice(idx, 1);
    return { deleted: true, id };
  }

  // 用来演示「未知异常如何被 AllExceptionsFilter 兜底」
  triggerBoom(): never {
    throw new Error('💥 故意抛出的非 HttpException，应该被 Filter 兜成 500');
  }
}
