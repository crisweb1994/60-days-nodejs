import type { Post, PostRevision, PostWriteData } from '../entities/post.entity';
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
  create(data: PostWriteData): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findBySlug(slug: string): Promise<Post | null>;

  // offset 分页（GET /posts）：返回当页 + 总数。能跳任意页，但深翻慢、并发下会漂移。
  findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }>;

  // Day 28 —— 游标 / keyset 分页（GET /posts/feed）：只能顺序往下翻，但稳定、深翻不掉速。
  findByCursor(query: QueryPostDto, cursor: CursorPayload | null): Promise<CursorResult>;

  // Day 28 —— 全文搜索（GET /posts/search）：按相关度排序。
  search(query: SearchPostDto): Promise<{ items: Post[]; total: number }>;

  // Day 29 —— 更新。expectedVersion 提供时做乐观锁检查（版本不匹配抛 VERSION_CONFLICT）；
  // 无论是否提供，成功更新都自增 version，并在同一事务里写一条修订快照。
  // 返回 null = 记录不存在。
  update(
    id: string,
    patch: Partial<PostWriteData>,
    expectedVersion?: number,
  ): Promise<Post | null>;

  // Day 29 —— 浏览计数原子自增（可交换操作，无需乐观锁 / 行锁）。返回 null = 记录不存在。
  incrementViewCount(id: string): Promise<Post | null>;

  // Day 37 —— 按浏览数从高到低取 Top N（published）。
  // 排行榜的「数据库兜底」：Redis ZSET 不可用 / 榜空时，用这条 SQL 顶上。
  findTopByViewCount(limit: number): Promise<Post[]>;

  // Day 39 —— 设置 / 清除封面图 URL。只改 meta.coverImage：不 bump version、不写修订
  // （封面不是内容变更，不该出现在修订历史里）。coverUrl=null 表示清除。
  // 返回 null = 记录不存在。
  setCoverImage(postId: string, coverUrl: string | null): Promise<Post | null>;

  // Day 29 —— 列出某篇文章的修订历史（新 → 旧）。
  listRevisions(postId: string): Promise<PostRevision[]>;

  remove(id: string): Promise<boolean>;
}
