import type { Post } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { SearchPostDto } from '../dto/search-post.dto';
import type { CursorPayload } from '../cursor';

// 用 Symbol 做 DI token，避免和字符串 token 撞名
// Service 通过 @Inject(POSTS_REPOSITORY) 拿到实现
export const POSTS_REPOSITORY = Symbol('POSTS_REPOSITORY');

// 游标分页的返回：当页数据 + 下一页游标（null 表示没有下一页了）
export interface CursorResult {
  items: Post[];
  nextCursor: string | null;
}

// 仓储接口：业务语言（findBySlug / findMany），不出现 ORM 概念（whereClause / orderBy 数组）
// 所有方法返回 Promise —— 内存实现也走 async，换 Prisma 时调用方零改动
export interface PostsRepository {
  create(data: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findBySlug(slug: string): Promise<Post | null>;

  // offset 分页（GET /posts）：返回当页 + 总数。能跳任意页，但深翻慢、并发下会漂移。
  findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }>;

  // Day 28 —— 游标 / keyset 分页（GET /posts/feed）：只能顺序往下翻，但稳定、深翻不掉速。
  // cursor 已由 Service 解码好（null = 第一页）；repo 只负责把它翻译成 keyset 查询。
  findByCursor(query: QueryPostDto, cursor: CursorPayload | null): Promise<CursorResult>;

  // Day 28 —— 全文搜索（GET /posts/search）：按相关度排序。
  // ⚠️ 这是接口里"最不便携"的一个：真正的分词 / 词干 / 排序是 PG 的能力，
  //    内存实现只能做近似（见 InMemoryPostsRepository.search 的注释）。
  search(query: SearchPostDto): Promise<{ items: Post[]; total: number }>;

  update(id: string, patch: Partial<Omit<Post, 'id' | 'createdAt'>>): Promise<Post | null>;
  remove(id: string): Promise<boolean>;
}
