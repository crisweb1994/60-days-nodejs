import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ============================================================================
// 集成测试（e2e）：起完整 Nest 应用 + 真 PostgreSQL。
// Day 33 起，写接口（create/update/delete）需要登录 + 权限——读接口仍公开。
//
// ⚠️ 会清空 posts / users / refresh_tokens。务必指向一次性库/schema。先 pnpm prisma:migrate。
//    e2e 用 --test-concurrency=1 串行跑，避免 auth.e2e 并行清 users 把这里的测试用户删掉。
// ============================================================================

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;

// Day 33：测试用户（在 before 里注册一次）
let authorToken = '';
let authorId = '';
let otherToken = '';
let adminToken = '';
const asAuthor = () => ({ authorization: `Bearer ${authorToken}` });
const asOther = () => ({ authorization: `Bearer ${otherToken}` });
const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });

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

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.PAGE_LIMIT = '20';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';

  app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);

  // 一次性建三个测试用户：author（写文章）、other（别人）、admin
  await prisma.post.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const author = await req('POST', '/auth/register', {
    email: 'author@e2e.test',
    username: 'author',
    password: 'Pass-1234',
  });
  authorToken = author.json.data.accessToken;
  authorId = author.json.data.user.id;

  otherToken = (
    await req('POST', '/auth/register', {
      email: 'other@e2e.test',
      username: 'other',
      password: 'Pass-1234',
    })
  ).json.data.accessToken;

  const admin = await req('POST', '/auth/register', {
    email: 'admin@e2e.test',
    username: 'adminuser',
    password: 'Pass-1234',
  });
  // 注册默认 role=user；直接改库提到 admin，再登录拿带 admin 角色的 token
  await prisma.user.update({
    where: { id: admin.json.data.user.id },
    data: { role: 'admin' },
  });
  adminToken = (
    await req('POST', '/auth/login', {
      email: 'admin@e2e.test',
      password: 'Pass-1234',
    })
  ).json.data.accessToken;
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  // 只清 posts，保留 before() 建的测试用户（authorId 是 SetNull，删 posts 不影响用户）
  await prisma.post.deleteMany();
});

const validPost = (over: Record<string, unknown> = {}) => ({
  title: 'Hello Day 27',
  slug: 'hello-day-27',
  content: 'a long enough content body for validation',
  status: 'draft',
  ...over,
});

// ─── 验收清单（写接口现在要带 author token）──────────────────────────

test('1) 正常创建 → 201 + code:0 + 完整 Post + authorId=当前用户', async () => {
  const r = await req('POST', '/posts', validPost(), asAuthor());
  assert.equal(r.status, 201);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.message, 'ok');
  assert.equal(r.json.data.title, 'Hello Day 27');
  assert.ok(r.json.data.id);
  assert.ok(r.json.data.createdAt);
  assert.equal(r.json.data.authorId, authorId, 'Day 33：作者=当前登录用户');
});

test('2) 字段缺失 → 400 + VALIDATION_ERROR + 结构化 errors', async () => {
  const r = await req('POST', '/posts', { title: 'x' }, asAuthor());
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(r.json.errors));
  assert.ok(r.json.errors.some((e: any) => e.field === 'slug'));
  assert.ok(r.json.errors.some((e: any) => e.field === 'content'));
});

test('3) 多余字段 → 400 + VALIDATION_ERROR（forbidNonWhitelisted）', async () => {
  const r = await req('POST', '/posts', validPost({ evil: true, isAdmin: true }), asAuthor());
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('4) 重复 slug → 409 + SLUG_TAKEN + category=business', async () => {
  await req('POST', '/posts', validPost({ slug: 'dup-slug' }), asAuthor());
  const r = await req('POST', '/posts', validPost({ slug: 'dup-slug' }), asAuthor());
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
  await req('POST', '/posts', validPost({ slug: 'a', title: 'NestJS guide', status: 'published' }), asAuthor());
  await req('POST', '/posts', validPost({ slug: 'b', title: 'Express guide', status: 'draft' }), asAuthor());
  await req('POST', '/posts', validPost({ slug: 'c', title: 'NestJS deep dive', status: 'published' }), asAuthor());

  const r = await req('GET', '/posts?keyword=nest&status=published&sortBy=title&order=asc');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 2);
  assert.equal(r.json.data.items[0].title, 'NestJS deep dive');
  assert.equal(r.json.data.pagination.total, 2);
});

test('tag 过滤：tags 数组列的 has 查询', async () => {
  await req('POST', '/posts', validPost({ slug: 't1', tags: ['nestjs', 'prisma'] }), asAuthor());
  await req('POST', '/posts', validPost({ slug: 't2', tags: ['redis'] }), asAuthor());

  const r = await req('GET', '/posts?tag=prisma');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 1);
  assert.equal(r.json.data.items[0].slug, 't1');
});

test('archived 文章拒绝更新 → POST_ARCHIVED', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'arch', status: 'archived' }), asAuthor());
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'new title' }, asAuthor());
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'POST_ARCHIVED');
  assert.equal(r.json.category, 'business');
});

test('更新后再查：改动真的落到了 PG', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'upd', title: 'before' }), asAuthor());
  const id = created.json.data.id;
  await req('PATCH', `/posts/${id}`, { title: 'after' }, asAuthor());
  const got = await req('GET', `/posts/${id}`);
  assert.equal(got.json.data.title, 'after');
});

test('删除：DELETE 后再 GET → 404', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'del' }), asAuthor());
  const id = created.json.data.id;
  const del = await req('DELETE', `/posts/${id}`, undefined, asAuthor());
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
  for (const t of ['a', 'b', 'c', 'd', 'e']) {
    await req('POST', '/posts', validPost({ slug: `p-${t}`, title: t }), asAuthor());
  }

  const p1 = await req('GET', '/posts/feed?limit=2&sortBy=title&order=asc');
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.json.data.items.map((i: any) => i.title), ['a', 'b']);
  assert.equal(p1.json.data.pageInfo.hasMore, true);
  assert.ok(p1.json.data.pageInfo.nextCursor);

  const c1 = encodeURIComponent(p1.json.data.pageInfo.nextCursor);
  const p2 = await req('GET', `/posts/feed?limit=2&sortBy=title&order=asc&cursor=${c1}`);
  assert.deepEqual(p2.json.data.items.map((i: any) => i.title), ['c', 'd']);
  assert.equal(p2.json.data.pageInfo.hasMore, true);

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
    await req('POST', '/posts', validPost({ slug: t, title: t }), asAuthor());
  }
  const p1 = await req('GET', '/posts/feed?limit=2');
  assert.equal(p1.status, 200);
  assert.equal(p1.json.data.items.length, 2);
  assert.equal(p1.json.data.pageInfo.hasMore, true);

  const c = encodeURIComponent(p1.json.data.pageInfo.nextCursor);
  const p2 = await req('GET', `/posts/feed?limit=2&cursor=${c}`);
  assert.equal(p2.json.data.items.length, 1);
  assert.equal(p2.json.data.pageInfo.hasMore, false);

  const seen = [...p1.json.data.items, ...p2.json.data.items].map((i: any) => i.id);
  assert.equal(new Set(seen).size, 3);
});

// ─── Day 28：全文搜索 ───────────────────────────────────────

test('search：命中正文里的词，非命中项不返回', async () => {
  await req('POST', '/posts', validPost({
    slug: 's1',
    title: 'PostgreSQL full text search',
    content: 'tsvector and tsquery make ranking possible',
  }), asAuthor());
  await req('POST', '/posts', validPost({
    slug: 's2',
    title: 'Redis caching basics',
    content: 'nothing relevant to the other topic here at all',
  }), asAuthor());

  const r = await req('GET', '/posts/search?q=tsvector');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 1);
  assert.equal(r.json.data.items[0].slug, 's1');
  assert.equal(r.json.data.pagination.total, 1);
  assert.equal(r.json.data.items[0].version, 1);
  assert.equal(r.json.data.items[0].viewCount, 0);
  assert.equal(r.json.data.items[0].authorId, authorId, '搜索结果也要带 authorId');
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
  const r = await req('POST', '/posts', validPost({ slug: 'd29-new' }), asAuthor());
  assert.equal(r.json.data.version, 1);
  assert.equal(r.json.data.viewCount, 0);
});

test('update：version 自增，并在事务里留下修订快照', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-rev', title: 'v1' }), asAuthor());
  const id = created.json.data.id;
  assert.equal(created.json.data.version, 1);

  const u1 = await req('PATCH', `/posts/${id}`, { title: 'v2' }, asAuthor());
  assert.equal(u1.json.data.version, 2);
  const u2 = await req('PATCH', `/posts/${id}`, { title: 'v3' }, asAuthor());
  assert.equal(u2.json.data.version, 3);

  const revs = await req('GET', `/posts/${id}/revisions`);
  assert.equal(revs.status, 200);
  assert.equal(revs.json.data.length, 2);
  assert.equal(revs.json.data[0].version, 3);
  assert.equal(revs.json.data[0].title, 'v3');
  assert.equal(revs.json.data[1].version, 2);
});

test('乐观锁：带正确 version → 成功，version 前进', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-ol-ok' }), asAuthor());
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'ok', version: 1 }, asAuthor());
  assert.equal(r.status, 200);
  assert.equal(r.json.data.version, 2);
});

test('乐观锁：带过期 version → 409 VERSION_CONFLICT', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-ol-conflict' }), asAuthor());
  const id = created.json.data.id;
  await req('PATCH', `/posts/${id}`, { title: 'first', version: 1 }, asAuthor());
  const r = await req('PATCH', `/posts/${id}`, { title: 'second', version: 1 }, asAuthor());
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'VERSION_CONFLICT');
  assert.equal(r.json.category, 'business');
});

test('浏览计数：POST /:id/view 原子自增，不动 version、不产生修订（公开，无需登录）', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'd29-view' }), asAuthor());
  const id = created.json.data.id;
  const v1 = await req('POST', `/posts/${id}/view`); // 公开，不带 token
  assert.equal(v1.status, 200);
  assert.equal(v1.json.data.viewCount, 1);
  const v2 = await req('POST', `/posts/${id}/view`);
  assert.equal(v2.json.data.viewCount, 2);
  assert.equal(v2.json.data.version, 1);
  assert.equal(v2.json.data.updatedAt, created.json.data.updatedAt);
  const revs = await req('GET', `/posts/${id}/revisions`);
  assert.equal(revs.json.data.length, 0);
});

test('浏览计数：不存在的 id → 404', async () => {
  const r = await req('POST', '/posts/00000000-0000-4000-8000-000000000000/view');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'POST_NOT_FOUND');
});

// ─── Day 33：RBAC / 资源级权限 ───────────────────────────────

test('创建：不带 token → 401 UNAUTHORIZED', async () => {
  const r = await req('POST', '/posts', validPost({ slug: 'noauth' }));
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
});

test('更新：别人的文章 → 403 FORBIDDEN', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'owned' }), asAuthor());
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'hijack' }, asOther());
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'FORBIDDEN');
  // 没改成
  const got = await req('GET', `/posts/${id}`);
  assert.notEqual(got.json.data.title, 'hijack');
});

test('更新：作者本人 → 200', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'mine' }), asAuthor());
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'updated by owner' }, asAuthor());
  assert.equal(r.status, 200);
  assert.equal(r.json.data.title, 'updated by owner');
});

test('更新：admin 改别人的文章 → 200', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'byadmin' }), asAuthor());
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'updated by admin' }, asAdmin());
  assert.equal(r.status, 200);
  assert.equal(r.json.data.title, 'updated by admin');
});

test('删除：别人的文章 → 403；admin 删任意 → 200', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'todelete' }), asAuthor());
  const id = created.json.data.id;
  const forbidden = await req('DELETE', `/posts/${id}`, undefined, asOther());
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, 'FORBIDDEN');
  const ok = await req('DELETE', `/posts/${id}`, undefined, asAdmin());
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.deleted, true);
});

test('删除：不存在的文章（先 404，优先于 403）', async () => {
  const r = await req(
    'DELETE',
    '/posts/00000000-0000-4000-8000-000000000000',
    undefined,
    asOther(),
  );
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'POST_NOT_FOUND');
});
