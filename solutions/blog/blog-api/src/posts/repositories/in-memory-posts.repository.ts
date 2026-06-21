import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { encodeCursor, type CursorPayload } from '../cursor';
import type {
  Post,
  PostMeta,
  PostRevision,
  PostStatus,
  PostWriteData,
} from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { SearchPostDto } from '../dto/search-post.dto';
import type { CursorResult, PostsRepository } from './posts.repository';

@Injectable()
export class InMemoryPostsRepository implements PostsRepository {
  // Map 比数组快、删除/查找原生 O(1)；并且导出顺序稳定，方便测试
  private readonly store = new Map<string, Post>();
  // Day 29：每篇文章的修订历史（postId → 快照数组）
  private readonly revisions = new Map<string, PostRevision[]>();

  async create(data: PostWriteData): Promise<Post> {
    const now = new Date();
    const post: Post = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      version: 1,
      viewCount: 0,
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

  // 列表 / 游标共用的过滤：keyword(子串) + status + tag。对应 Prisma 版的 baseWhere()，
  // 抽出来避免 findMany / findByCursor 各抄一份、改一处漏一处。
  private filterBy(
    items: Post[],
    query: { keyword?: string; status?: PostStatus; tag?: string },
  ): Post[] {
    let out = items;
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      out = out.filter(
        (p) =>
          p.title.toLowerCase().includes(kw) ||
          p.content.toLowerCase().includes(kw),
      );
    }
    if (query.status) out = out.filter((p) => p.status === query.status);
    if (query.tag) out = out.filter((p) => p.tags.includes(query.tag!));
    return out;
  }

  async findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    const items = this.filterBy(Array.from(this.store.values()), query);

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

  async findByCursor(
    query: QueryPostDto,
    cursor: CursorPayload | null,
  ): Promise<CursorResult> {
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    let items = this.filterBy(Array.from(this.store.values()), query);

    // 把排序值统一序列化成字符串：日期用 ISO（ISO 字符串字典序 = 时间序），title 用原文。
    // 这样比较全是 string 比较，且和游标里存的 v 形状一致（Prisma 版同款约定）。
    const valOf = (p: Post): string =>
      sortBy === 'title' ? p.title : (p[sortBy] as Date).toISOString();
    const dir = order === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const av = valOf(a);
      const bv = valOf(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // 主键相等：按 id 同方向兜底，形成全序
      return a.id < b.id ? -1 * dir : a.id > b.id ? 1 * dir : 0;
    });

    if (cursor) {
      const cv = cursor.v; // 已是序列化后的字符串
      // 只保留严格"排在游标之后"的行（keyset）
      items = items.filter((p) => {
        const pv = valOf(p);
        if (pv !== cv) return order === 'asc' ? pv > cv : pv < cv;
        return order === 'asc' ? p.id > cursor.id : p.id < cursor.id;
      });
    }

    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const last = pageItems[pageItems.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ v: valOf(last), id: last.id })
        : null;
    return { items: pageItems, nextCursor };
  }

  async search(
    query: SearchPostDto,
  ): Promise<{ items: Post[]; total: number }> {
    // ⚠️ 内存版无法真正全文搜索（没有分词器 / 词干 / tsvector）。这里只做朴素的
    // "所有关键词都出现即命中 + 按出现次数粗排"，仅为满足接口契约、让单测不依赖 DB；
    // 语义和 PG 版（websearch_to_tsquery + ts_rank）并不等价——这正是抽象的"漏点"。
    const words = query.q.toLowerCase().split(/\s+/).filter(Boolean);
    // 没有任何有效词（如 q 全是空白）→ 空结果，和 PG 端空 tsquery 行为对齐。
    // 防止 words 为空时 words.every(...) 恒真、把全表都"命中"。
    if (words.length === 0) return { items: [], total: 0 };
    let items = Array.from(this.store.values()).filter((p) => {
      const hay = (p.title + ' ' + p.content).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (query.status) items = items.filter((p) => p.status === query.status);

    const score = (p: Post): number => {
      const hay = (p.title + ' ' + p.content).toLowerCase();
      return words.reduce((n, w) => n + (hay.split(w).length - 1), 0);
    };
    items.sort(
      (a, b) =>
        score(b) - score(a) || b.createdAt.getTime() - a.createdAt.getTime(),
    );

    const total = items.length;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const start = (page - 1) * limit;
    return { items: items.slice(start, start + limit), total };
  }

  async update(
    id: string,
    patch: Partial<PostWriteData>,
    expectedVersion?: number,
  ): Promise<Post | null> {
    const post = this.store.get(id);
    if (!post) return null;
    // 乐观锁：版本不匹配 → 409（和 Prisma 版同语义）。
    // ⚠️ 内存版做不到真正的事务原子性：下面"改 post + 记修订"不是一个原子单元，
    //    只为满足接口契约 / 让单测能跑——又一个抽象的"漏点"（对照 search）。
    if (expectedVersion !== undefined && post.version !== expectedVersion) {
      throw new BusinessException(
        ErrorCodes.VERSION_CONFLICT,
        '文章已被其他人修改，请刷新后重试',
        HttpStatus.CONFLICT,
      );
    }
    const next: Post = {
      ...post,
      ...patch,
      version: post.version + 1,
      updatedAt: new Date(),
    };
    this.store.set(id, next);
    // 快照一条修订
    const list = this.revisions.get(id) ?? [];
    list.push({
      id: randomUUID(),
      postId: id,
      version: next.version,
      title: next.title,
      content: next.content,
      createdAt: new Date(),
    });
    this.revisions.set(id, list);
    return next;
  }

  async incrementViewCount(id: string): Promise<Post | null> {
    const post = this.store.get(id);
    if (!post) return null;
    const next: Post = { ...post, viewCount: post.viewCount + 1 };
    this.store.set(id, next);
    return next;
  }

  // Day 37 —— 排行榜的 DB 兜底：按浏览数降序取 Top N（published）。
  async findTopByViewCount(limit: number): Promise<Post[]> {
    return Array.from(this.store.values())
      .filter((p) => p.status === 'published')
      .sort((a, b) => b.viewCount - a.viewCount || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  // Day 39 —— 封面图：合并进 meta.coverImage，不 bump version、不记修订（和 Prisma 版同语义）。
  async setCoverImage(postId: string, coverUrl: string | null): Promise<Post | null> {
    const post = this.store.get(postId);
    if (!post) return null;
    const meta = { ...(post.meta ?? ({} as PostMeta)) };
    if (coverUrl === null) delete meta.coverImage;
    else meta.coverImage = coverUrl;
    const next: Post = { ...post, meta };
    this.store.set(postId, next);
    return next;
  }

  async listRevisions(postId: string): Promise<PostRevision[]> {
    const list = this.revisions.get(postId) ?? [];
    return [...list].sort((a, b) => b.version - a.version); // 新 → 旧
  }

  async remove(id: string): Promise<boolean> {
    this.revisions.delete(id); // 级联清掉修订（对应 onDelete: Cascade）
    return this.store.delete(id);
  }

  // 仅给测试用：把存储清空。生产代码里不应该有调用
  /** @internal */
  clear(): void {
    this.store.clear();
    this.revisions.clear();
  }
}
