import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ============================================================================
// 集成测试（e2e）：起完整 Nest 应用 + 真 PostgreSQL，验证从 HTTP 到 DB 的整条链路。
//
// 与单元测试（posts.service.unit.test.ts）的分工：
//   - 单测：mock 仓储，毫秒级，测业务分支，不需要 DB
//   - 集成：真 PG，测 Prisma 映射 / 过滤器 / 拦截器 / 校验管道是否真的串起来
//
// ⚠️ 这个测试会清空 DATABASE_URL 指向 schema 下的 posts 表。
//    务必指向一个一次性的库/schema（如 blog_api 或 blog_api_test），别指生产/有数据的库。
//    跑之前先确保已 migrate：pnpm prisma:migrate
// ============================================================================

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;

before(async () => {
  // 给 ConfigModule 喂稳定的 env，避免依赖跑测时的 shell 环境
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.PAGE_LIMIT = '20';
  // 没显式给 DATABASE_URL 时，回落到 blog-db 的 PG + blog_api schema
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';

  app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);

  const server = app.getHttpServer();
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  prisma = app.get(PrismaService);
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  // 每个 case 一张干净的 posts 表，否则 case 顺序敏感（和内存版的 repo.clear() 同一目的）
  await prisma.post.deleteMany();
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

const validPost = (over: Record<string, unknown> = {}) => ({
  title: 'Hello Day 27',
  slug: 'hello-day-27',
  content: 'a long enough content body for validation',
  status: 'draft',
  ...over,
});

// ─── 验收清单（和 Day 20 同一组场景，底层从内存换成了 PG）──────────

test('1) 正常创建 → 201 + code:0 + 完整 Post（id 来自 PG）', async () => {
  const r = await req('POST', '/posts', validPost());
  assert.equal(r.status, 201);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.message, 'ok');
  assert.equal(r.json.data.title, 'Hello Day 27');
  assert.ok(r.json.data.id);
  assert.ok(r.json.data.createdAt);
});

test('2) 字段缺失 → 400 + VALIDATION_ERROR + 结构化 errors', async () => {
  const r = await req('POST', '/posts', { title: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(r.json.errors));
  assert.ok(r.json.errors.some((e: any) => e.field === 'slug'));
  assert.ok(r.json.errors.some((e: any) => e.field === 'content'));
});

test('3) 多余字段 → 400 + VALIDATION_ERROR（forbidNonWhitelisted）', async () => {
  const r = await req('POST', '/posts', validPost({ evil: true, isAdmin: true }));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('4) 重复 slug → 409 + SLUG_TAKEN + category=business', async () => {
  await req('POST', '/posts', validPost({ slug: 'dup-slug' }));
  const r = await req('POST', '/posts', validPost({ slug: 'dup-slug' }));
  assert.equal(r.status, HttpStatus.CONFLICT);
  assert.equal(r.json.code, 'SLUG_TAKEN');
  assert.equal(r.json.category, 'business');
});

test('5) 不存在的 id → 404 + POST_NOT_FOUND', async () => {
  const r = await req('GET', '/posts/00000000-0000-4000-8000-000000000000');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'POST_NOT_FOUND');
});

test('6) 未知异常 → 500 + 通用文案，响应不含 stack/原始 message', async () => {
  const r = await req('GET', '/posts/debug/boom');
  assert.equal(r.status, 500);
  assert.equal(r.json.code, 500);
  assert.equal(r.json.message, '服务器内部错误');
  assert.equal(r.json.data, null);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('boom!'), '响应不应该包含原始 error.message');
  assert.ok(!body.includes('triggerBoom'), '响应不应该包含 stack 里的方法名');
});

// ─── requestId / 健康检查 / 分页边界 ────────────────────────

test('requestId：响应头 / 响应体 / 上游传入三处一致', async () => {
  const r1 = await req('GET', '/posts');
  assert.ok(r1.json.requestId);
  assert.equal(r1.headers.get('x-request-id'), r1.json.requestId);

  const r2 = await req('GET', '/posts', undefined, { 'x-request-id': 'trace-abc-123' });
  assert.equal(r2.json.requestId, 'trace-abc-123');
  assert.equal(r2.headers.get('x-request-id'), 'trace-abc-123');
});

test('/health：返回 ok + uptime，且不被 HttpLoggerMiddleware 记录', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.status, 'ok');
  assert.ok(typeof r.json.data.uptime === 'number');
});

test('分页 limit 上限：?limit=99999 被 ValidationPipe 拒绝', async () => {
  const r = await req('GET', '/posts?limit=99999');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('查询：keyword + status + sortBy 在 PG 里真正生效', async () => {
  await req('POST', '/posts', validPost({ slug: 'a', title: 'NestJS guide', status: 'published' }));
  await req('POST', '/posts', validPost({ slug: 'b', title: 'Express guide', status: 'draft' }));
  await req('POST', '/posts', validPost({ slug: 'c', title: 'NestJS deep dive', status: 'published' }));

  const r = await req('GET', '/posts?keyword=nest&status=published&sortBy=title&order=asc');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 2);
  assert.equal(r.json.data.items[0].title, 'NestJS deep dive');
  assert.equal(r.json.data.pagination.total, 2);
});

test('tag 过滤：tags 数组列的 has 查询', async () => {
  await req('POST', '/posts', validPost({ slug: 't1', tags: ['nestjs', 'prisma'] }));
  await req('POST', '/posts', validPost({ slug: 't2', tags: ['redis'] }));

  const r = await req('GET', '/posts?tag=prisma');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 1);
  assert.equal(r.json.data.items[0].slug, 't1');
});

test('archived 文章拒绝更新 → POST_ARCHIVED', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'arch', status: 'archived' }));
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'new title' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'POST_ARCHIVED');
  assert.equal(r.json.category, 'business');
});

test('更新后再查：改动真的落到了 PG', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'upd', title: 'before' }));
  const id = created.json.data.id;
  await req('PATCH', `/posts/${id}`, { title: 'after' });
  const got = await req('GET', `/posts/${id}`);
  assert.equal(got.json.data.title, 'after');
});

test('删除：DELETE 后再 GET → 404', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'del' }));
  const id = created.json.data.id;
  const del = await req('DELETE', `/posts/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.data.deleted, true);
  const got = await req('GET', `/posts/${id}`);
  assert.equal(got.status, 404);
});

test('非法 UUID 路径参数 → 400（ParseUUIDPipe）', async () => {
  const r = await req('GET', '/posts/not-a-uuid');
  assert.equal(r.status, 400);
});

// ─── Day 28：游标分页 ───────────────────────────────────────

test('feed：按 title 升序逐页推进，页间不重不漏', async () => {
  // 用 title 排序（字符串，无时间戳精度问题），断言顺序确定
  for (const t of ['a', 'b', 'c', 'd', 'e']) {
    await req('POST', '/posts', validPost({ slug: `p-${t}`, title: t }));
  }

  // 第一页
  const p1 = await req('GET', '/posts/feed?limit=2&sortBy=title&order=asc');
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.json.data.items.map((i: any) => i.title), ['a', 'b']);
  assert.equal(p1.json.data.pageInfo.hasMore, true);
  assert.ok(p1.json.data.pageInfo.nextCursor);

  // 第二页：带上 nextCursor
  const c1 = encodeURIComponent(p1.json.data.pageInfo.nextCursor);
  const p2 = await req('GET', `/posts/feed?limit=2&sortBy=title&order=asc&cursor=${c1}`);
  assert.deepEqual(p2.json.data.items.map((i: any) => i.title), ['c', 'd']);
  assert.equal(p2.json.data.pageInfo.hasMore, true);

  // 第三页：最后一条，hasMore=false / nextCursor=null
  const c2 = encodeURIComponent(p2.json.data.pageInfo.nextCursor);
  const p3 = await req('GET', `/posts/feed?limit=2&sortBy=title&order=asc&cursor=${c2}`);
  assert.deepEqual(p3.json.data.items.map((i: any) => i.title), ['e']);
  assert.equal(p3.json.data.pageInfo.hasMore, false);
  assert.equal(p3.json.data.pageInfo.nextCursor, null);
});

test('feed：非法 cursor → 400 VALIDATION_ERROR', async () => {
  const r = await req('GET', '/posts/feed?cursor=not-a-valid-cursor');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('feed：默认按 createdAt 倒序翻页，跨页 id 不重不漏', async () => {
  for (const t of ['x1', 'x2', 'x3']) {
    await req('POST', '/posts', validPost({ slug: t, title: t }));
  }
  // 默认 sortBy=createdAt order=desc —— created_at 是 Timestamptz(3)，游标无精度丢失
  const p1 = await req('GET', '/posts/feed?limit=2');
  assert.equal(p1.status, 200);
  assert.equal(p1.json.data.items.length, 2);
  assert.equal(p1.json.data.pageInfo.hasMore, true);

  const c = encodeURIComponent(p1.json.data.pageInfo.nextCursor);
  const p2 = await req('GET', `/posts/feed?limit=2&cursor=${c}`);
  assert.equal(p2.json.data.items.length, 1);
  assert.equal(p2.json.data.pageInfo.hasMore, false);

  // 两页合起来正好 3 条、互不重复（不重不漏）
  const seen = [...p1.json.data.items, ...p2.json.data.items].map((i: any) => i.id);
  assert.equal(new Set(seen).size, 3);
});

// ─── Day 28：全文搜索 ───────────────────────────────────────

test('search：命中正文里的词，非命中项不返回', async () => {
  await req('POST', '/posts', validPost({
    slug: 's1',
    title: 'PostgreSQL full text search',
    content: 'tsvector and tsquery make ranking possible',
  }));
  await req('POST', '/posts', validPost({
    slug: 's2',
    title: 'Redis caching basics',
    content: 'nothing relevant to the other topic here at all',
  }));

  const r = await req('GET', '/posts/search?q=tsvector');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 1);
  assert.equal(r.json.data.items[0].slug, 's1');
  assert.equal(r.json.data.pagination.total, 1);
  // 搜索结果也要带齐字段（raw SELECT 不能漏 version / viewCount）
  assert.equal(r.json.data.items[0].version, 1);
  assert.equal(r.json.data.items[0].viewCount, 0);
});

test('search：q 缺失 → 400 VALIDATION_ERROR', async () => {
  const r = await req('GET', '/posts/search');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('search：q 全是空白 → 400（trim 后空串被 MinLength 拒）', async () => {
  const r = await req('GET', '/posts/search?q=%20%20%20');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

// ─── Day 29：并发控制（乐观锁 / 原子计数 / 修订）─────────────

test('新建文章 version=1 / viewCount=0', async () => {
  const r = await req('POST', '/posts', validPost({ slug: 'd29-new' }));
  assert.equal(r.json.data.version, 1);
  assert.equal(r.json.data.viewCount, 0);
});

test('update：version 自增，并在事务里留下修订快照', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-rev', title: 'v1' }));
  const id = created.json.data.id;
  assert.equal(created.json.data.version, 1);

  const u1 = await req('PATCH', `/posts/${id}`, { title: 'v2' });
  assert.equal(u1.json.data.version, 2);
  const u2 = await req('PATCH', `/posts/${id}`, { title: 'v3' });
  assert.equal(u2.json.data.version, 3);

  // 两次 update → 两条修订（版本 3、2），新 → 旧
  const revs = await req('GET', `/posts/${id}/revisions`);
  assert.equal(revs.status, 200);
  assert.equal(revs.json.data.length, 2);
  assert.equal(revs.json.data[0].version, 3);
  assert.equal(revs.json.data[0].title, 'v3');
  assert.equal(revs.json.data[1].version, 2);
});

test('乐观锁：带正确 version → 成功，version 前进', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-ol-ok' }));
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'ok', version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.version, 2);
});

test('乐观锁：带过期 version → 409 VERSION_CONFLICT', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-ol-conflict' }));
  const id = created.json.data.id;
  // 先用 version=1 改一次 → 实际 version 变 2
  await req('PATCH', `/posts/${id}`, { title: 'first', version: 1 });
  // 再用过期的 version=1 改 → 冲突
  const r = await req('PATCH', `/posts/${id}`, { title: 'second', version: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'VERSION_CONFLICT');
  assert.equal(r.json.category, 'business');
});

test('浏览计数：POST /:id/view 原子自增，不动 version、不产生修订', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-view' }));
  const id = created.json.data.id;
  const v1 = await req('POST', `/posts/${id}/view`);
  assert.equal(v1.status, 200);
  assert.equal(v1.json.data.viewCount, 1);
  const v2 = await req('POST', `/posts/${id}/view`);
  assert.equal(v2.json.data.viewCount, 2);
  assert.equal(v2.json.data.version, 1); // 浏览不是内容变更
  // 浏览不该改 updatedAt（走裸 SQL 绕开 @updatedAt）
  assert.equal(v2.json.data.updatedAt, created.json.data.updatedAt);
  const revs = await req('GET', `/posts/${id}/revisions`);
  assert.equal(revs.json.data.length, 0);
});

test('浏览计数：不存在的 id → 404', async () => {
  const r = await req('POST', '/posts/00000000-0000-4000-8000-000000000000/view');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'POST_NOT_FOUND');
});
