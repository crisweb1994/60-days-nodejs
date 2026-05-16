import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatePostDto } from './dto/create-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { Post } from './entities/post.entity';

@Injectable()
export class PostsService {
  private posts: Post[] = [];
  private nextId = 1;

  constructor() {
    this.create({
      title: 'Hello Validation',
      slug: 'hello-validation',
      content: '一个用来演示 ValidationPipe 与 DTO 的样例文章。',
      tags: ['nestjs', 'validation'],
      status: 'published',
    });
  }

  findAll(query: QueryPostDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    let list = this.posts;
    if (query.tag) list = list.filter((p) => p.tags.includes(query.tag!));
    if (query.status) list = list.filter((p) => p.status === query.status);

    const start = (page - 1) * limit;
    return {
      data: list.slice(start, start + limit),
      pagination: { page, limit, total: list.length },
    };
  }

  findOne(id: number) {
    const post = this.posts.find((p) => p.id === id);
    if (!post) throw new NotFoundException(`Post #${id} not found`);
    return post;
  }

  create(dto: CreatePostDto): Post {
    if (this.posts.some((p) => p.slug === dto.slug)) {
      throw new ConflictException(`slug "${dto.slug}" 已存在`);
    }
    const now = new Date();
    const post: Post = {
      id: this.nextId++,
      title: dto.title,
      slug: dto.slug,
      content: dto.content,
      tags: dto.tags ?? [],
      status: dto.status,
      meta: dto.meta,
      createdAt: now,
      updatedAt: now,
    };
    this.posts.push(post);
    return post;
  }

  update(id: number, dto: UpdatePostDto) {
    const post = this.findOne(id);
    if (dto.slug && dto.slug !== post.slug && this.posts.some((p) => p.slug === dto.slug)) {
      throw new ConflictException(`slug "${dto.slug}" 已存在`);
    }
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    Object.assign(post, changes, { updatedAt: new Date() });
    return post;
  }

  remove(id: number) {
    const idx = this.posts.findIndex((p) => p.id === id);
    if (idx === -1) throw new NotFoundException(`Post #${id} not found`);
    this.posts.splice(idx, 1);
    return { deleted: true, id };
  }
}
