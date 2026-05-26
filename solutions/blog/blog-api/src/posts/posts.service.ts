import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { CreatePostDto } from './dto/create-post.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import {
  POSTS_REPOSITORY,
  type PostsRepository,
} from './repositories/posts.repository';

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

  async create(dto: CreatePostDto) {
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
    });
  }

  async update(id: string, dto: UpdatePostDto) {
    const post = await this.findOne(id); // 复用 NOT_FOUND 分支
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
    // 只保留显式提供的字段，避免把 undefined 写回去覆盖原值
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    const updated = await this.repo.update(id, patch);
    if (!updated) {
      // 极少出现：update 之前刚 findOne 通过，理论上不会到这；防御性兜底
      throw new NotFoundException(`Post #${id} not found`);
    }
    return updated;
  }

  async remove(id: string) {
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
