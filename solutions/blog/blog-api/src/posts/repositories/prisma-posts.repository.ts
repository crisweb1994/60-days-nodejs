import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type Post as PrismaPost,
  type PostRevision as PrismaRevision,
} from '@prisma/client';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { encodeCursor, type CursorPayload } from '../cursor';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { SearchPostDto } from '../dto/search-post.dto';
import type {
  Post,
  PostMeta,
  PostRevision,
  PostStatus,
  PostWriteData,
} from '../entities/post.entity';
import type { CursorResult, PostsRepository } from './posts.repository';

/**
 * Prisma 版仓储。它做且只做一件事：把 Prisma 的行（PrismaPost）翻译成领域实体（Post），
 * 反过来把领域语言（findBySlug / findMany(query)）翻译成 Prisma 查询。
 *
 * 这一层就是"防腐层"：Service / Controller / DTO 永远看不到 PrismaPost、Prisma.PostWhereInput
 * 这些 ORM 概念。哪天换 Drizzle、换 TypeORM，只动这个文件。
 *
 * ★ 注意它和 InMemoryPostsRepository 实现的是同一个接口 PostsRepository。
 *   posts.module.ts 把 POSTS_REPOSITORY 这个 token 从 InMemory 换成它——Service 一行不改。
 */
@Injectable()
export class PrismaPostsRepository implements PostsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── 映射：DB 行 → 领域实体 ──────────────────────────────────────────
  // 单独抽出来，保证每个出口（findById/findBySlug/findMany/create/update）形状一致
  private toDomain(row: PrismaPost): Post {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      content: row.content,
      tags: row.tags,
      // status / meta 是 DB 端的"宽类型"，这里收窄回领域类型。
      // status 的合法值由写入路径（CreatePostDto 的枚举校验）保证，所以直接断言。
      status: row.status as PostStatus,
      // meta 在 DB 是可空 JSONB，读出来是 Prisma.JsonValue | null。
      // 生产代码这里应该用 Zod 再校验一次（见 Day 26 §JSON 不安全），demo 先直接断言。
      meta: (row.meta ?? undefined) as PostMeta | undefined,
      authorId: row.authorId ?? undefined,
      version: row.version,
      viewCount: row.viewCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // DB 修订行 → 领域修订
  private toRevision(row: PrismaRevision): PostRevision {
    return {
      id: row.id,
      postId: row.postId,
      version: row.version,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt,
    };
  }

  // 只把 **slug** 的唯一约束冲突（P2002 且 target 命中 slug）翻译成 409 SLUG_TAKEN。
  // 不能见 P2002 就当 slug——posts 上还有别的唯一约束（如 post_revisions 的
  // (post_id, version)），那类冲突若也报 "slug 已被占用" 就是误导。靠 e.meta.target 区分。
  private isSlugConflict(e: unknown): boolean {
    if (
      !(e instanceof Prisma.PrismaClientKnownRequestError) ||
      e.code !== 'P2002'
    ) {
      return false;
    }
    // P2002 的 meta.target 是冲突字段名数组（或约束名），slug 冲突里一定含 'slug'
    const target = (e.meta as { target?: unknown } | undefined)?.target;
    return JSON.stringify(target ?? '').includes('slug');
  }

  private slugTaken(): BusinessException {
    return new BusinessException(
      ErrorCodes.SLUG_TAKEN,
      'slug 已被占用',
      HttpStatus.CONFLICT,
    );
  }

  // 乐观锁版本冲突 → 409。客户端拿到后应重新读取、合并、带新 version 重试。
  private versionConflict(): BusinessException {
    return new BusinessException(
      ErrorCodes.VERSION_CONFLICT,
      '文章已被其他人修改，请刷新后重试',
      HttpStatus.CONFLICT,
    );
  }

  // 列表 / 游标都用得到的过滤条件：keyword(ILIKE) + status + tag。抽出来给两个分页方法共用。
  private baseWhere(query: {
    keyword?: string;
    status?: PostStatus;
    tag?: string;
  }): Prisma.PostWhereInput {
    const where: Prisma.PostWhereInput = {};
    if (query.keyword) {
      // 关键字匹配 title 或 content，不区分大小写（PG ILIKE）
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { content: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    if (query.status) where.status = query.status;
    // tags 是数组列：has 等价于 SQL 的 'tag' = ANY(tags)
    if (query.tag) where.tags = { has: query.tag };
    return where;
  }

  // 从一行生成游标：排序字段值（日期→ISO，title→原文）+ id
  private cursorOf(row: PrismaPost, sortBy: string): string {
    const v =
      sortBy === 'title'
        ? row.title
        : (row[sortBy as 'createdAt' | 'updatedAt'] as Date).toISOString();
    return encodeCursor({ v, id: row.id });
  }

  async create(data: PostWriteData): Promise<Post> {
    try {
      const row = await this.prisma.post.create({
        data: {
          title: data.title,
          slug: data.slug,
          content: data.content,
          // tags 在领域类型里就是必填 string[]，Service 已统一兜底成 []，这里不再 ?? []
          tags: data.tags,
          status: data.status,
          // Day 33：作者。Service 给登录用户的创建会带上 authorId；没传就落 NULL（无主）
          authorId: data.authorId ?? null,
          // meta 没传就不写这个键，让它落 DB NULL；传了才作为 JSON 写入。
          // PostMeta 是具名 interface，没有索引签名，要先经 unknown 再断言成 JSON 输入类型
          ...(data.meta !== undefined
            ? { meta: data.meta as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      return this.toDomain(row);
    } catch (e) {
      // 正常路径 Service 已 findBySlug 预检；这里兜"预检到写入之间被并发插队"的竞态
      if (this.isSlugConflict(e)) throw this.slugTaken();
      throw e;
    }
  }

  async findById(id: string): Promise<Post | null> {
    const row = await this.prisma.post.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findBySlug(slug: string): Promise<Post | null> {
    const row = await this.prisma.post.findUnique({ where: { slug } });
    return row ? this.toDomain(row) : null;
  }

  async findMany(
    query: QueryPostDto,
  ): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    // 把 DTO 翻译成 Prisma 的 where——keyword(ILIKE) / status / tag，下推到 PG
    const where = this.baseWhere(query);

    // ★ count 和 findMany 包进 $transaction 数组（Day 26）：两条查询在同一个事务、
    //   一次往返里执行。但注意没传 isolationLevel，默认是 Read Committed——
    //   每条语句各取一次快照，所以这 *并不* 保证 total 和当页"同一时刻"。
    //   要让两者绝对一致，得加 isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead。
    //   列表接口通常不值得为此上 RR；这里用数组事务图的是少一次往返 + 语义清晰（见 README §7）。
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        // sortBy 已在 QueryPostDto 白名单校验过，这里动态拼 key 是安全的。
        // 追加 id 作为稳定的次级排序键：主键（如 createdAt）相等时 PG 返回顺序本是
        // 未定义的，补 id 让分页在多页之间稳定、可重现，避免漏行 / 重复行。
        orderBy: [
          { [sortBy]: order } as Prisma.PostOrderByWithRelationInput,
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return { items: rows.map((r) => this.toDomain(r)), total };
  }

  async findByCursor(
    query: QueryPostDto,
    cursor: CursorPayload | null,
  ): Promise<CursorResult> {
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';
    // desc 想要"排在游标后面"= 比游标更小的行；asc 则是更大的行
    const op = order === 'asc' ? 'gt' : 'lt';

    const where = this.baseWhere(query);

    if (cursor) {
      // keyset：WHERE (sortBy, id) 在游标"之后"。复合比较 Prisma 没有直接算子，
      // 拆成等价的两支 OR：  sortBy <op> v   OR   (sortBy = v AND id <op> cursorId)
      // 计算键用 unknown 断言：动态 key 的字面量类型和 PostWhereInput 对不上，但语义正确。
      const v = sortBy === 'title' ? cursor.v : new Date(cursor.v);
      const keyset: Prisma.PostWhereInput = {
        OR: [
          { [sortBy]: { [op]: v } } as unknown as Prisma.PostWhereInput,
          {
            [sortBy]: v,
            id: { [op]: cursor.id },
          } as unknown as Prisma.PostWhereInput,
        ],
      };
      // 和 keyword 的 OR 共存：放进 AND，避免两个顶层 OR 互相覆盖
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), keyset];
    }

    // 多取一条：用来判断"还有没有下一页"，这一条不返回给客户端
    const rows = await this.prisma.post.findMany({
      where,
      orderBy: [
        { [sortBy]: order } as Prisma.PostOrderByWithRelationInput,
        { id: order }, // 次级键方向要和主键一致，keyset 才自洽
      ],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? this.cursorOf(page[page.length - 1], sortBy)
        : null;

    return { items: page.map((r) => this.toDomain(r)), nextCursor };
  }

  async search(
    query: SearchPostDto,
  ): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    // status 是可选过滤：用 Prisma.sql 安全拼接（参数化，不是字符串拼接，无注入风险）
    const statusFilter = query.status
      ? Prisma.sql`AND status = ${query.status}`
      : Prisma.empty;

    // websearch_to_tsquery：按"搜索引擎语法"解析用户输入（支持 "短语"、or、-排除），
    //   且对乱输入容错——比 to_tsquery 安全（后者遇到裸空格 / 符号会直接抛错）。
    // 'simple' 配置：不做词干、不去停用词，结果可预期（换 'english' 能获得词干归并）。
    // count(*) OVER()：窗口函数，一条查询同时拿到总命中数，省一次 count 往返（呼应 Day 23）。
    // 列别名 "createdAt"/"updatedAt"：让 raw 行形状对齐 PrismaPost，复用 toDomain。
    const rows = await this.prisma.$queryRaw<
      Array<PrismaPost & { total: bigint }>
    >`
      SELECT id, title, slug, content, tags, status, meta, version,
             view_count AS "viewCount",
             author_id AS "authorId",
             created_at AS "createdAt",
             updated_at AS "updatedAt",
             count(*) OVER() AS total
      FROM posts
      WHERE to_tsvector('simple', title || ' ' || content)
            @@ websearch_to_tsquery('simple', ${query.q})
            ${statusFilter}
      ORDER BY ts_rank(
                 to_tsvector('simple', title || ' ' || content),
                 websearch_to_tsquery('simple', ${query.q})
               ) DESC,
               created_at DESC,
               id DESC                                   -- 唯一兜底键：rank+时间都打平时仍稳定，offset 翻页不重不漏
      LIMIT ${limit} OFFSET ${offset}
    `;

    // count(*) OVER() 是 bigint，转成 number；空结果集时没有行可取，总数 0
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return { items: rows.map((r) => this.toDomain(r)), total };
  }

  async update(
    id: string,
    patch: Partial<PostWriteData>,
    expectedVersion?: number,
  ): Promise<Post | null> {
    // Service 已把 undefined 过滤掉，这里只搬运确实存在的键；version 每次更新都自增。
    const data: Prisma.PostUpdateInput = { version: { increment: 1 } };
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.meta !== undefined)
      data.meta = patch.meta as unknown as Prisma.InputJsonValue;

    // ★ 把"改 post + 写修订"放进一个交互式事务：要么都成、要么都不成（原子性）。
    //   版本冲突时在事务里 throw → 整个事务回滚，修订也不会留下半条。
    try {
      return await this.prisma.$transaction(async (tx) => {
        let row: PrismaPost;
        if (expectedVersion !== undefined) {
          // 乐观锁：WHERE id AND version = expected。命中 0 行 = 版本变了 或 记录没了。
          const res = await tx.post.updateMany({
            where: { id, version: expectedVersion },
            data,
          });
          if (res.count === 0) {
            // 区分"被并发删除"和"版本冲突"：再查一次
            const exists = await tx.post.findUnique({
              where: { id },
              select: { id: true },
            });
            if (!exists) return null; // 记录没了 → 交给 Service 当 NOT_FOUND
            throw this.versionConflict(); // 版本不匹配 → 409（抛出回滚事务）
          }
          // updateMany 只返回 count，拿不到行，要再查一次
          row = await tx.post.findUniqueOrThrow({ where: { id } });
        } else {
          // 不带版本：last-write-wins（最后写入者赢），但仍自增 version。
          // update 直接返回更新后的行，无需再查（比乐观锁分支省一次 SELECT）。
          row = await tx.post.update({ where: { id }, data });
        }

        // 同一事务里快照一条修订
        await tx.postRevision.create({
          data: {
            postId: row.id,
            version: row.version,
            title: row.title,
            content: row.content,
          },
        });
        return this.toDomain(row);
      });
    } catch (e) {
      // P2025（不带版本、记录不存在）→ null；P2002（改 slug 撞名竞态）→ 409 SLUG_TAKEN
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return null;
      }
      if (this.isSlugConflict(e)) throw this.slugTaken();
      throw e;
    }
  }

  async incrementViewCount(id: string): Promise<Post | null> {
    try {
      // 原子自增，没有"读-改-写"竞态，不需要乐观锁 / 行锁。
      // ★ 故意走裸 SQL 而不是 prisma.post.update：浏览不是内容变更，不该改 updated_at。
      //   而 Prisma 的 @updatedAt 会在**任何** update/updateMany 时把 updated_at 设成 now()，
      //   那样既不符合语义，还会让 sortBy=updatedAt 的游标分页因为浏览而漂移（Day 28）。
      //   裸 SQL 绕开 @updatedAt；RETURNING 用列别名对齐 PrismaPost，复用 toDomain。
      const rows = await this.prisma.$queryRaw<PrismaPost[]>`
        UPDATE posts SET view_count = view_count + 1
        WHERE id = ${id}::uuid
        RETURNING id, title, slug, content, tags, status, meta, version,
                  view_count AS "viewCount",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
      `;
      return rows.length > 0 ? this.toDomain(rows[0]) : null;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return null;
      }
      throw e;
    }
  }

  // Day 37 —— 排行榜的 DB 兜底。view_count 上没有索引时是全表排序，只在 ZSET 不可用时才走。
  async findTopByViewCount(limit: number): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { status: 'published' },
      orderBy: [
        { viewCount: 'desc' },
        { id: 'asc' }, // 浏览数打平时，次级键兜底，保证顺序稳定
      ],
      take: limit,
    });
    return rows.map((r) => this.toDomain(r));
  }

  // Day 39 —— 封面图：读当前 meta → 合并 coverImage → 只回写 meta 这一列。
  // 用专门的 update（而非 update() 接口的乐观锁路径），避免 bump version、避免写一条「内容没变」的修订。
  async setCoverImage(postId: string, coverUrl: string | null): Promise<Post | null> {
    try {
      const current = await this.prisma.post.findUnique({
        where: { id: postId },
        select: { meta: true },
      });
      if (!current) return null;

      // 合并：以现有 meta 为底，覆盖/删除 coverImage。
      const base = (current.meta ?? {}) as Record<string, unknown>;
      if (coverUrl === null) delete base.coverImage;
      else base.coverImage = coverUrl;

      const row = await this.prisma.post.update({
        where: { id: postId },
        data: { meta: base as unknown as Prisma.InputJsonValue },
      });
      return this.toDomain(row);
    } catch (e) {
      // update 不存在的 id → P2025 → 返回 null（交给 Service 当 NOT_FOUND）
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return null;
      }
      throw e;
    }
  }

  async listRevisions(postId: string): Promise<PostRevision[]> {
    const rows = await this.prisma.postRevision.findMany({
      where: { postId },
      orderBy: { version: 'desc' }, // 新 → 旧
    });
    return rows.map((r) => this.toRevision(r));
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.prisma.post.delete({ where: { id } });
      return true;
    } catch (e) {
      // 删一条不存在的记录 → P2025 → 返回 false（和内存版 Map.delete 的语义对齐）
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return false;
      }
      throw e;
    }
  }
}
