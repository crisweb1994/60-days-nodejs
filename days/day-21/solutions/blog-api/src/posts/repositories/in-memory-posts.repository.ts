import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Post } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { PostsRepository } from './posts.repository';

@Injectable()
export class InMemoryPostsRepository implements PostsRepository {
  // Map 比数组快、删除/查找原生 O(1)；并且导出顺序稳定，方便测试
  private readonly store = new Map<string, Post>();

  async create(data: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>): Promise<Post> {
    const now = new Date();
    const post: Post = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...data,
    };
    this.store.set(post.id, post);
    return post;
  }

  async findById(id: string): Promise<Post | null> {
    return this.store.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Post | null> {
    for (const post of this.store.values()) {
      if (post.slug === slug) return post;
    }
    return null;
  }

  async findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    let items = Array.from(this.store.values());

    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      items = items.filter(
        (p) =>
          p.title.toLowerCase().includes(kw) ||
          p.content.toLowerCase().includes(kw),
      );
    }
    if (query.status) items = items.filter((p) => p.status === query.status);
    if (query.tag) items = items.filter((p) => p.tags.includes(query.tag!));

    // sortBy 白名单已在 DTO 校验，这里直接索引安全
    items.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const dir = order === 'asc' ? 1 : -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    const total = items.length;
    const start = (page - 1) * limit;
    return { items: items.slice(start, start + limit), total };
  }

  async update(
    id: string,
    patch: Partial<Omit<Post, 'id' | 'createdAt'>>,
  ): Promise<Post | null> {
    const post = this.store.get(id);
    if (!post) return null;
    const next: Post = { ...post, ...patch, updatedAt: new Date() };
    this.store.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  // 仅给测试用：把存储清空。生产代码里不应该有调用
  /** @internal */
  clear(): void {
    this.store.clear();
  }
}
