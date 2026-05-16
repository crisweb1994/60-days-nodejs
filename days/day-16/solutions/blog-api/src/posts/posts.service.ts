import { Injectable, NotFoundException } from '@nestjs/common';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { Post } from './entities/post.entity';

@Injectable()
export class PostsService {
  // 内存存储：Day 16 还未接入数据库，下一阶段会替换为 PostgreSQL
  private posts: Post[] = [];
  private nextId = 1;

  findAll(query: QueryPostDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // 按 author / tag 过滤
    let list = this.posts;
    if (query.author) {
      list = list.filter(p => p.author === query.author);
    }
    if (query.tag) {
      list = list.filter(p => p.tags.includes(query.tag!));
    }

    // 按创建时间倒序，分页切片
    const sorted = [...list].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const start = (page - 1) * limit;
    const data = sorted.slice(start, start + limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total: list.length,
        totalPages: Math.ceil(list.length / limit),
      },
    };
  }

  findOne(id: number): Post {
    const post = this.posts.find(p => p.id === id);
    if (!post) {
      throw new NotFoundException(`Post #${id} not found`);
    }
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

  update(id: number, dto: UpdatePostDto): Post {
    const post = this.findOne(id);
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    Object.assign(post, changes, { updatedAt: new Date() });
    return post;
  }

  remove(id: number): { deleted: true; id: number } {
    const index = this.posts.findIndex(p => p.id === id);
    if (index === -1) {
      throw new NotFoundException(`Post #${id} not found`);
    }
    this.posts.splice(index, 1);
    return { deleted: true, id };
  }
}
