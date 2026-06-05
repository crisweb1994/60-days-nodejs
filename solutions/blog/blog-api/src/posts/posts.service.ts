import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { decodeCursor } from './cursor';
import { CreatePostDto } from './dto/create-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { SearchPostDto } from './dto/search-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import type { Post } from './entities/post.entity';
import {
  POSTS_REPOSITORY,
  type PostsRepository,
} from './repositories/posts.repository';

// Day 33：当前操作者（来自 JWT 的 sub + role），结构和 auth 的 JwtPayload 兼容
export interface Actor {
  sub: string;
  role: string;
}

@Injectable()
export class PostsService {
  constructor(
    @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
  ) {}

  async findAll(query: QueryPostDto) {
    const { items, total } = await this.repo.findMany(query);
    return {
      items,
      pagination: {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        total,
      },
    };
  }

  // 游标分页（GET /posts/feed）：解码游标 → 查 keyset → 回 nextCursor。
  async feed(query: QueryPostDto) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    // 传了 cursor 却解不出来 → 不是"第一页"，是非法输入，直接 400（别静默当第一页）
    if (query.cursor && !cursor) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_ERROR,
        'cursor 参数非法',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { items, nextCursor } = await this.repo.findByCursor(query, cursor);
    return {
      items,
      // 游标分页不返回 total / page：要么算不准、要么代价高，且客户端也用不上
      pageInfo: {
        nextCursor,
        hasMore: nextCursor !== null,
        limit: query.limit ?? 20,
      },
    };
  }

  // 全文搜索（GET /posts/search）：按相关度排序，offset 分页（搜索很少深翻）。
  async search(dto: SearchPostDto) {
    const { items, total } = await this.repo.search(dto);
    return {
      items,
      pagination: {
        page: dto.page ?? 1,
        limit: dto.limit ?? 20,
        total,
      },
    };
  }

  async findOne(id: string) {
    const post = await this.repo.findById(id);
    if (!post) {
      throw new BusinessException(
        ErrorCodes.POST_NOT_FOUND,
        `Post #${id} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return post;
  }

  // Day 29：浏览计数 +1（原子）。不存在 → 404。
  async incrementView(id: string) {
    const post = await this.repo.incrementViewCount(id);
    if (!post) {
      throw new BusinessException(
        ErrorCodes.POST_NOT_FOUND,
        `Post #${id} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return post;
  }

  // Day 29：修订历史。先确认文章存在（复用 findOne 的 404），再列修订。
  async listRevisions(id: string) {
    await this.findOne(id);
    return this.repo.listRevisions(id);
  }

  async create(dto: CreatePostDto, authorId: string) {
    if (await this.repo.findBySlug(dto.slug)) {
      throw new BusinessException(
        ErrorCodes.SLUG_TAKEN,
        `slug "${dto.slug}" 已被占用`,
        HttpStatus.CONFLICT,
      );
    }
    return this.repo.create({
      title: dto.title,
      slug: dto.slug,
      content: dto.content,
      tags: dto.tags ?? [],
      status: dto.status,
      meta: dto.meta,
      authorId, // Day 33：作者 = 当前登录用户
    });
  }

  // Day 33：资源级权限——admin 可改任意文章；其他人只能改自己写的；
  // 无主文章（authorId 空，迁移前的老数据）只有 admin 能改。
  private assertCanModify(post: Post, actor: Actor) {
    if (actor.role === 'admin') return;
    if (post.authorId && post.authorId === actor.sub) return;
    throw new BusinessException(
      ErrorCodes.FORBIDDEN,
      '只有作者或管理员可以修改这篇文章',
      HttpStatus.FORBIDDEN,
    );
  }

  async update(id: string, dto: UpdatePostDto, actor: Actor) {
    const post = await this.findOne(id); // 复用 NOT_FOUND 分支（404 优先于 403）
    this.assertCanModify(post, actor);
    if (post.status === 'archived') {
      throw new BusinessException(
        ErrorCodes.POST_ARCHIVED,
        `Post #${id} 已归档，不能再修改`,
        HttpStatus.CONFLICT,
      );
    }
    if (dto.slug && dto.slug !== post.slug) {
      const exists = await this.repo.findBySlug(dto.slug);
      if (exists) {
        throw new BusinessException(
          ErrorCodes.SLUG_TAKEN,
          `slug "${dto.slug}" 已被占用`,
          HttpStatus.CONFLICT,
        );
      }
    }
    // version 是乐观锁的"期望版本"，不是要写入的内容字段，先摘出来
    const { version, ...rest } = dto;
    // 只保留显式提供的字段，避免把 undefined 写回去覆盖原值
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    const updated = await this.repo.update(id, patch, version);
    if (!updated) {
      // 极少出现：update 之前刚 findOne 通过，理论上不会到这；防御性兜底
      throw new NotFoundException(`Post #${id} not found`);
    }
    return updated;
  }

  async remove(id: string, actor: Actor) {
    // 先查出来：404 优先于 403，且要拿到 authorId 做权限判断
    const post = await this.findOne(id);
    this.assertCanModify(post, actor);
    const ok = await this.repo.remove(id);
    if (!ok) {
      throw new BusinessException(
        ErrorCodes.POST_NOT_FOUND,
        `Post #${id} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return { deleted: true, id };
  }

  // 给 /posts/debug/boom 用：故意抛非 HttpException，验证全局兜底脱敏
  triggerBoom(): never {
    throw new Error('boom! 这条 message 不应该被客户端看到');
  }
}
