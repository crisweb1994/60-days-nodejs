import {
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../cache/redis.service';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { setCacheState } from '../common/request-context';
import type { AppConfig } from '../config/configuration';
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
  // 列表缓存的 key 前缀：失效时按前缀 SCAN 清掉所有页/排序/过滤变体
  private static readonly LIST_PREFIX = 'posts:list:';
  private static readonly postKey = (id: string) => `post:${id}`;

  // 缓存击穿守卫：同一 key 的「在途加载」共享同一个 Promise，避免高并发下打出 N 条同样的 DB 查询。
  // 只在单进程内有效；多实例要换成基于 Redis 的分布式锁（SETNX）。
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
    // ★ 都是 @Optional()：单元测试里 new PostsService(mockRepo) 不传它们也能跑（cache=undefined → 跳过缓存）。
    //   生产环境 CacheModule（全局）会注入 RedisService，AppModule 注入 ConfigService。
    @Optional() private readonly cache?: RedisService,
    @Optional() private readonly config?: ConfigService<AppConfig, true>,
  ) {}

  // ── 读路径：Cache-Aside（旁路缓存） ────────────────────────────────────
  // 思路就一句：「读的时候先问缓存，没有再问数据库，拿到后顺手回填缓存」。
  // 写路径（create/update/remove）负责把缓存「失效」——绝不试图去「更新」缓存（那是 Write-Through 的活，
  // 要处理并发一致性，复杂得多，收益在这个场景里不划算）。见 README 三种策略对比。

  async findAll(query: QueryPostDto) {
    if (!this.cache || !this.cache.available) {
      setCacheState('BYPASS'); // 无缓存层（如单测）/ Redis 掉线——绕过缓存直连库
      return this.loadList(query);
    }
    const key = PostsService.listKey(query);
    const cached = await this.cache.get(key);
    if (cached) {
      setCacheState('HIT', key);
      return this.deserializeList(cached);
    }
    // 列表缓存同样用 coalesce 防击穿
    const result = await this.coalesce(key, () => this.loadList(query));
    await this.cache.set(key, JSON.stringify(result), this.listTtl);
    setCacheState('MISS', key);
    return result;
  }

  // 游标分页（GET /posts/feed）：解码游标 → 查 keyset → 回 nextCursor。
  // ★ 不缓存：游标 token 的基数几乎是「无限」（每次翻页一个新 token），缓存命中率趋近 0，
  //   还要处理失效——典型的「不该缓存」场景。见 README「哪些数据不该缓存」。
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
  // ★ 不缓存：搜索词组合是高基数、强时效（新建文章会改变排序结果），缓存性价比低。
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

  async findOne(id: string): Promise<Post> {
    if (!this.cache || !this.cache.available) {
      setCacheState('BYPASS'); // 无缓存层 / Redis 掉线——绕过缓存直连库，X-Cache=BYPASS 方便观测降级
      return this.loadById(id);
    }
    const key = PostsService.postKey(id);
    const cached = await this.cache.get(key);
    if (cached) {
      setCacheState('HIT', key);
      return this.deserializePost(cached);
    }
    // 缓存击穿（thundering herd）：高并发下同一个 key 同时未命中，会瞬间打出 N 条同样的 DB 查询。
    // coalesce 把「同一个 key 的并发加载」合并成一次 DB 调用。
    const post = await this.coalesce(key, () => this.loadById(id));
    // loadById 在文章不存在时会抛 404——负结果不缓存（缓存空值要额外处理反序列化与穿透问题），
    // 直接让它冒泡。只有真正查到数据才回填。
    await this.cache.set(key, this.serialize(post), this.postTtl);
    setCacheState('MISS', key);
    return post;
  }

  // Day 29：浏览计数 +1（原子）。不存在 → 404。
  // ★ 这里故意【不】失效单篇缓存：浏览数是低价值、强写入（每次访问都 +1）的字段，
  //   如果每次浏览都清缓存，findOne 的缓存基本就废了。我们接受 viewCount 在 TTL 内「最终一致」
  //   （最多滞后 postTtl 秒）——对「显示用」的计数完全够。这是「能接受多旧的陈旧数据」的典型权衡。
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

  // Day 29：修订历史。先确认文章存在（复用 loadById 的 404），再列修订。
  async listRevisions(id: string) {
    await this.loadById(id);
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
    const created = await this.repo.create({
      title: dto.title,
      slug: dto.slug,
      content: dto.content,
      tags: dto.tags ?? [],
      status: dto.status,
      meta: dto.meta,
      authorId, // Day 33：作者 = 当前登录用户
    });
    // 新文章会出现在列表里（分页、首页都可能变）→ 失效所有列表缓存。单篇 key 还不存在，无需 del。
    await this.invalidate();
    return created;
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
    const post = await this.loadById(id); // 复用 NOT_FOUND 分支（404 优先于 403）
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
    // 改了内容/标题/排序相关字段 → 单篇和列表都可能脏。先失效，再返回（写后失效，见 README）。
    await this.invalidate(id);
    return updated;
  }

  async remove(id: string, actor: Actor) {
    // 先查出来：404 优先于 403，且要拿到 authorId 做权限判断
    const post = await this.loadById(id);
    this.assertCanModify(post, actor);
    const ok = await this.repo.remove(id);
    if (!ok) {
      throw new BusinessException(
        ErrorCodes.POST_NOT_FOUND,
        `Post #${id} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.invalidate(id);
    return { deleted: true, id };
  }

  // 给 /posts/debug/boom 用：故意抛非 HttpException，验证全局兜底脱敏
  triggerBoom(): never {
    throw new Error('boom! 这条 message 不应该被客户端看到');
  }

  // ── Cache-Aside 的内部零件 ────────────────────────────────────────────

  // 不走缓存的「读源」：纯 DB 查询 + 404。内部路径（update/remove/listRevisions 的前置校验）
  // 直接用它——这些路径要么马上要改数据、要么不需要缓存，绕开缓存避免污染 X-Cache 头。
  private async loadById(id: string): Promise<Post> {
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

  private async loadList(query: QueryPostDto) {
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

  // 把查询参数稳定序列化成 list 缓存 key。
  // ★ 字段顺序固定：否则 {a:1,b:2} 和 {b:2,a:1} 会被当成两个 key，等于没缓存。
  //   明文保留方便 redis-cli 调试；生产 key 过长/含特殊字符时一般再套一层 sha256 哈希。
  private static listKey(query: QueryPostDto): string {
    const normalized = JSON.stringify({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      sortBy: query.sortBy ?? 'createdAt',
      order: query.order ?? 'desc',
      keyword: query.keyword ?? '',
      tag: query.tag ?? '',
      status: query.status ?? '',
    });
    return `${PostsService.LIST_PREFIX}${normalized}`;
  }

  // 缓存击穿守卫：同一 key 的并发加载只触发一次真正的 loader，其余调用复用同一个 Promise。
  // 利用 JS 单线程特性——get 与 set 之间没有 await，不会被其它微任务插队，所以不会漏。
  private async coalesce<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = loader().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  // 写后失效：删单篇（精确 key）+ 清列表（按前缀）。宁可多删不可少删——缓存多留一秒 = 用户多看一秒旧数据。
  private async invalidate(postId?: string): Promise<void> {
    if (!this.cache) return;
    if (postId) await this.cache.del(PostsService.postKey(postId));
    // 一篇文章变了，所有页/排序/过滤的列表都可能受影响——按前缀全清。
    // ★ 这正是「列表缓存远不如单篇缓存划算」的根因：失效要 SCAN 扫描（单篇失效是 O(1) 的 del）。
    await this.cache.delByPrefix(PostsService.LIST_PREFIX);
  }

  private get postTtl(): number {
    return this.config?.get('redis.postTtlSec', { infer: true }) ?? 300;
  }

  private get listTtl(): number {
    return this.config?.get('redis.listTtlSec', { infer: true }) ?? 60;
  }

  // Post 进出缓存要处理 Date：JSON.stringify 把 Date 变成 ISO 字符串，
  // 反序列化时不恢复就是 string——下游若有 .getTime() 会炸。显式转回来保证缓存值和 DB 读出来的一致。
  private serialize(post: Post): string {
    return JSON.stringify(post);
  }

  private revivePost(p: Post): Post {
    return {
      ...p,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    };
  }

  private deserializePost(raw: string): Post {
    return this.revivePost(JSON.parse(raw));
  }

  private deserializeList(raw: string): {
    items: Post[];
    pagination: { page: number; limit: number; total: number };
  } {
    const obj = JSON.parse(raw) as {
      items: Post[];
      pagination: { page: number; limit: number; total: number };
    };
    return {
      items: obj.items.map((p) => this.revivePost(p)),
      pagination: obj.pagination,
    };
  }
}
