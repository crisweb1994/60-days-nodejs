import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { PostsService } from '../src/posts/posts.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import type { Post } from '../src/posts/entities/post.entity';
import type { PostsRepository } from '../src/posts/repositories/posts.repository';

// ============================================================================
// 单元测试：测 PostsService 的业务规则，不连数据库、不起 Nest。
//
// 手法：用一个"假仓储"(mock) 顶替真实仓储。Service 只依赖 PostsRepository 接口，
// 所以这里 new PostsService(mockRepo) 就能把业务逻辑单独拎出来测，毫秒级、可重复。
// 真正连 PG 的验证放在 posts.e2e.test.ts（集成测试）。
// ============================================================================

// 造一条领域 Post，用于 mock 返回
function fakePost(over: Partial<Post> = {}): Post {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Hello',
    slug: 'hello',
    content: 'long enough content',
    tags: [],
    status: 'draft',
    version: 1,
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// 一个可配置的 mock 仓储：默认所有查询返回空，单测里按需覆写某几个方法
function mockRepo(over: Partial<PostsRepository> = {}): PostsRepository {
  return {
    create: async (data) => fakePost(data as Partial<Post>),
    findById: async () => null,
    findBySlug: async () => null,
    findMany: async () => ({ items: [], total: 0 }),
    findByCursor: async () => ({ items: [], nextCursor: null }),
    search: async () => ({ items: [], total: 0 }),
    update: async (_id, patch) => fakePost(patch as Partial<Post>),
    incrementViewCount: async () => null,
    findTopByViewCount: async () => [],
    setCoverImage: async () => null,
    listRevisions: async () => [],
    remove: async () => true,
    ...over,
  };
}

// 断言抛的是带指定 bizCode 的 BusinessException
async function expectBizError(fn: () => Promise<unknown>, bizCode: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof BusinessException, `应该抛 BusinessException，实际：${err}`);
    assert.equal(err.bizCode, bizCode);
    return true;
  });
}

// Day 33：操作者（actor）
const ADMIN = { sub: 'admin-id', role: 'admin' };
const owner = (sub: string) => ({ sub, role: 'user' });

// ─── findOne ────────────────────────────────────────────────────────

test('findOne：仓储查不到 → 抛 POST_NOT_FOUND', async () => {
  const service = new PostsService(mockRepo({ findById: async () => null }));
  await expectBizError(() => service.findOne('no-such-id'), 'POST_NOT_FOUND');
});

test('findOne：查得到 → 原样返回', async () => {
  const post = fakePost({ title: 'Found' });
  const service = new PostsService(mockRepo({ findById: async () => post }));
  const got = await service.findOne(post.id);
  assert.equal(got.title, 'Found');
});

// ─── create ─────────────────────────────────────────────────────────

test('create：slug 已存在 → 抛 SLUG_TAKEN，不调用 repo.create', async () => {
  let createCalled = false;
  const service = new PostsService(
    mockRepo({
      findBySlug: async () => fakePost(),
      create: async (d) => {
        createCalled = true;
        return fakePost(d as Partial<Post>);
      },
    }),
  );
  await expectBizError(
    () =>
      service.create(
        { title: 'x', slug: 'taken', content: 'long enough', status: 'draft' } as any,
        'author-1',
      ),
    'SLUG_TAKEN',
  );
  assert.equal(createCalled, false, 'slug 撞名时不应该再写库');
});

test('create：slug 空闲 → tags 缺省补成空数组后落库', async () => {
  let received: any;
  const service = new PostsService(
    mockRepo({
      findBySlug: async () => null,
      create: async (d) => {
        received = d;
        return fakePost(d as Partial<Post>);
      },
    }),
  );
  await service.create(
    { title: 'New', slug: 'new', content: 'long enough', status: 'published' } as any,
    'author-1',
  );
  assert.deepEqual(received.tags, [], 'tags 未提供时 Service 应传 []');
  assert.equal(received.status, 'published');
  assert.equal(received.authorId, 'author-1', 'Day 33：作者 = 当前用户');
});

// ─── update ─────────────────────────────────────────────────────────

test('update：文章已归档 → 抛 POST_ARCHIVED', async () => {
  const archived = fakePost({ status: 'archived' });
  const service = new PostsService(mockRepo({ findById: async () => archived }));
  await expectBizError(
    () => service.update(archived.id, { title: 'new' } as any, ADMIN),
    'POST_ARCHIVED',
  );
});

test('update：改 slug 撞别人 → 抛 SLUG_TAKEN', async () => {
  const current = fakePost({ slug: 'old' });
  const service = new PostsService(
    mockRepo({
      findById: async () => current,
      findBySlug: async () => fakePost({ id: 'someone-else', slug: 'taken' }),
    }),
  );
  await expectBizError(
    () => service.update(current.id, { slug: 'taken' } as any, ADMIN),
    'SLUG_TAKEN',
  );
});

test('update：只把"显式提供的字段"传给仓储（undefined 不覆盖原值）', async () => {
  const current = fakePost({ slug: 'old', title: 'old title' });
  let patchSeen: any;
  const service = new PostsService(
    mockRepo({
      findById: async () => current,
      update: async (_id, patch) => {
        patchSeen = patch;
        return fakePost(patch as Partial<Post>);
      },
    }),
  );
  // 只改 title，其余字段为 undefined
  await service.update(
    current.id,
    { title: 'new title', content: undefined, tags: undefined } as any,
    ADMIN,
  );
  assert.deepEqual(Object.keys(patchSeen), ['title'], '只应携带 title 这一个 key');
  assert.equal(patchSeen.title, 'new title');
});

// ─── remove ─────────────────────────────────────────────────────────

test('remove：文章不存在 → POST_NOT_FOUND（findOne 先拦）', async () => {
  const service = new PostsService(mockRepo({ findById: async () => null }));
  await expectBizError(() => service.remove('no-such-id', ADMIN), 'POST_NOT_FOUND');
});

test('remove：存在且有权限，仓储 true → { deleted: true, id }', async () => {
  const service = new PostsService(
    mockRepo({ findById: async () => fakePost(), remove: async () => true }),
  );
  const r = await service.remove('some-id', ADMIN);
  assert.deepEqual(r, { deleted: true, id: 'some-id' });
});

// ─── Day 33：资源级权限（owner / admin）─────────────────────────────

test('update：非作者非 admin → FORBIDDEN', async () => {
  const post = fakePost({ authorId: 'alice' });
  const service = new PostsService(mockRepo({ findById: async () => post }));
  await expectBizError(
    () => service.update(post.id, { title: 'x' } as any, owner('bob')),
    'FORBIDDEN',
  );
});

test('update：作者本人 → 放行', async () => {
  const post = fakePost({ authorId: 'alice', slug: 'a' });
  let called = false;
  const service = new PostsService(
    mockRepo({
      findById: async () => post,
      update: async (_id, patch) => {
        called = true;
        return fakePost(patch as Partial<Post>);
      },
    }),
  );
  await service.update(post.id, { title: 'x' } as any, owner('alice'));
  assert.equal(called, true);
});

test('update：admin 改别人的文章 → 放行', async () => {
  const post = fakePost({ authorId: 'alice', slug: 'a' });
  let called = false;
  const service = new PostsService(
    mockRepo({
      findById: async () => post,
      update: async (_id, patch) => {
        called = true;
        return fakePost(patch as Partial<Post>);
      },
    }),
  );
  await service.update(post.id, { title: 'x' } as any, ADMIN);
  assert.equal(called, true);
});

test('update：无主文章（authorId 空）只有 admin 能改', async () => {
  const post = fakePost({ authorId: undefined });
  const service = new PostsService(mockRepo({ findById: async () => post }));
  await expectBizError(
    () => service.update(post.id, { title: 'x' } as any, owner('bob')),
    'FORBIDDEN',
  );
});

test('remove：非作者非 admin → FORBIDDEN，且不调用 repo.remove', async () => {
  let removeCalled = false;
  const post = fakePost({ authorId: 'alice' });
  const service = new PostsService(
    mockRepo({
      findById: async () => post,
      remove: async () => {
        removeCalled = true;
        return true;
      },
    }),
  );
  await expectBizError(() => service.remove(post.id, owner('bob')), 'FORBIDDEN');
  assert.equal(removeCalled, false, '权限不足时不应删除');
});

// ─── feed（游标分页）─────────────────────────────────────────────────

test('feed：cursor 非法 → 抛 VALIDATION_ERROR（不静默当第一页）', async () => {
  const service = new PostsService(mockRepo());
  await expectBizError(
    () => service.feed({ cursor: '!!!not-a-valid-cursor!!!' } as any),
    'VALIDATION_ERROR',
  );
});

test('feed：nextCursor 透传，hasMore 据其推导', async () => {
  const more = new PostsService(
    mockRepo({ findByCursor: async () => ({ items: [], nextCursor: 'abc' }) }),
  );
  const r1 = await more.feed({ limit: 10 } as any);
  assert.equal(r1.pageInfo.nextCursor, 'abc');
  assert.equal(r1.pageInfo.hasMore, true);
  assert.equal(r1.pageInfo.limit, 10);

  const done = new PostsService(
    mockRepo({ findByCursor: async () => ({ items: [], nextCursor: null }) }),
  );
  const r2 = await done.feed({} as any);
  assert.equal(r2.pageInfo.nextCursor, null);
  assert.equal(r2.pageInfo.hasMore, false);
});

// ─── search（全文搜索）───────────────────────────────────────────────

test('search：仓储的 total 透传到 pagination', async () => {
  const service = new PostsService(
    mockRepo({ search: async () => ({ items: [], total: 42 }) }),
  );
  const r = await service.search({ q: 'hello', page: 2, limit: 5 } as any);
  assert.equal(r.pagination.total, 42);
  assert.equal(r.pagination.page, 2);
  assert.equal(r.pagination.limit, 5);
});

// ─── Day 29：乐观锁 / 浏览计数 / 修订 ─────────────────────────────────

test('update：version 作为 expectedVersion 传给仓储，且不混进 patch', async () => {
  let seenPatch: any;
  let seenVersion: any;
  const current = fakePost({ slug: 'old', version: 3 });
  const service = new PostsService(
    mockRepo({
      findById: async () => current,
      update: async (_id, patch, expectedVersion) => {
        seenPatch = patch;
        seenVersion = expectedVersion;
        return fakePost(patch as Partial<Post>);
      },
    }),
  );
  await service.update(current.id, { title: 'new', version: 3 } as any, ADMIN);
  assert.equal(seenVersion, 3, 'version 应作为第三个参数传给仓储');
  assert.deepEqual(Object.keys(seenPatch), ['title'], 'version 不应混进 patch');
});

test('incrementView：仓储返回 null → POST_NOT_FOUND', async () => {
  const service = new PostsService(
    mockRepo({ incrementViewCount: async () => null }),
  );
  await expectBizError(() => service.incrementView('x'), 'POST_NOT_FOUND');
});

test('incrementView：返回更新后的 post', async () => {
  const service = new PostsService(
    mockRepo({ incrementViewCount: async () => fakePost({ viewCount: 5 }) }),
  );
  const r = await service.incrementView('x');
  assert.equal(r.viewCount, 5);
});

test('listRevisions：文章不存在 → POST_NOT_FOUND（先 findOne）', async () => {
  const service = new PostsService(mockRepo({ findById: async () => null }));
  await expectBizError(() => service.listRevisions('x'), 'POST_NOT_FOUND');
});

test('listRevisions：文章存在 → 透传仓储结果', async () => {
  const rev = {
    id: 'r1',
    postId: 'x',
    version: 2,
    title: 't',
    content: 'c',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const service = new PostsService(
    mockRepo({
      findById: async () => fakePost(),
      listRevisions: async () => [rev],
    }),
  );
  const r = await service.listRevisions('x');
  assert.equal(r.length, 1);
  assert.equal(r[0].version, 2);
});
