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
    update: async (_id, patch) => fakePost(patch as Partial<Post>),
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
      service.create({
        title: 'x',
        slug: 'taken',
        content: 'long enough',
        status: 'draft',
      } as any),
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
  await service.create({
    title: 'New',
    slug: 'new',
    content: 'long enough',
    status: 'published',
  } as any);
  assert.deepEqual(received.tags, [], 'tags 未提供时 Service 应传 []');
  assert.equal(received.status, 'published');
});

// ─── update ─────────────────────────────────────────────────────────

test('update：文章已归档 → 抛 POST_ARCHIVED', async () => {
  const archived = fakePost({ status: 'archived' });
  const service = new PostsService(mockRepo({ findById: async () => archived }));
  await expectBizError(
    () => service.update(archived.id, { title: 'new' } as any),
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
    () => service.update(current.id, { slug: 'taken' } as any),
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
  await service.update(current.id, {
    title: 'new title',
    content: undefined,
    tags: undefined,
  } as any);
  assert.deepEqual(Object.keys(patchSeen), ['title'], '只应携带 title 这一个 key');
  assert.equal(patchSeen.title, 'new title');
});

// ─── remove ─────────────────────────────────────────────────────────

test('remove：仓储返回 false → 抛 POST_NOT_FOUND', async () => {
  const service = new PostsService(mockRepo({ remove: async () => false }));
  await expectBizError(() => service.remove('no-such-id'), 'POST_NOT_FOUND');
});

test('remove：仓储返回 true → { deleted: true, id }', async () => {
  const service = new PostsService(mockRepo({ remove: async () => true }));
  const r = await service.remove('some-id');
  assert.deepEqual(r, { deleted: true, id: 'some-id' });
});
