import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Post as PrismaPost } from '@prisma/client';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { encodeCursor, type CursorPayload } from '../cursor';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { SearchPostDto } from '../dto/search-post.dto';
import type { Post, PostMeta, PostStatus } from '../entities/post.entity';
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // slug 唯一约束冲突（Prisma P2002）→ 翻译成业务语义的 409 SLUG_TAKEN。
  // 取舍：仓储本不该知道业务错误码，但把"DB 唯一冲突"收口在防腐层、翻译成应用的
  // 冲突语义，比让它漏成 500 合理——response 形状和 Service 抛 SLUG_TAKEN 完全一致。
  private isUniqueViolation(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
    );
  }

  private slugTaken(): BusinessException {
    return new BusinessException(
      ErrorCodes.SLUG_TAKEN,
      'slug 已被占用',
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

  async create(
    data: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Post> {
    try {
      const row = await this.prisma.post.create({
        data: {
          title: data.title,
          slug: data.slug,
          content: data.content,
          // tags 在领域类型里就是必填 string[]，Service 已统一兜底成 []，这里不再 ?? []
          tags: data.tags,
          status: data.status,
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
      if (this.isUniqueViolation(e)) throw this.slugTaken();
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
      SELECT id, title, slug, content, tags, status, meta,
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
    patch: Partial<Omit<Post, 'id' | 'createdAt'>>,
  ): Promise<Post | null> {
    // Service 已经把 undefined 字段过滤掉了，这里只搬运确实存在的键
    const data: Prisma.PostUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.meta !== undefined)
      data.meta = patch.meta as unknown as Prisma.InputJsonValue;

    try {
      const row = await this.prisma.post.update({ where: { id }, data });
      return this.toDomain(row);
    } catch (e) {
      // P2025 = 要更新的记录不存在。接口约定返回 null（不抛），交给 Service 决定语义
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return null;
      }
      // P2002 = 改 slug 撞了别人的唯一约束（竞态）→ 409 SLUG_TAKEN
      if (this.isUniqueViolation(e)) throw this.slugTaken();
      throw e;
    }
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
