import type { Post } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';

// 用 Symbol 做 DI token，避免和字符串 token 撞名
// Service 通过 @Inject(POSTS_REPOSITORY) 拿到实现
export const POSTS_REPOSITORY = Symbol('POSTS_REPOSITORY');

// 仓储接口：业务语言（findBySlug / findMany），不出现 ORM 概念（whereClause / orderBy 数组）
// 所有方法返回 Promise —— 内存实现也走 async，Day 21 换 Prisma 时调用方零改动
export interface PostsRepository {
  create(data: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findBySlug(slug: string): Promise<Post | null>;
  findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }>;
  update(id: string, patch: Partial<Omit<Post, 'id' | 'createdAt'>>): Promise<Post | null>;
  remove(id: string): Promise<boolean>;
}
