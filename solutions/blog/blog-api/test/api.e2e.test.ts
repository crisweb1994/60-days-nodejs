import 'reflect-metadata';
import { test, before, after, beforeEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { RedisService } from '../src/cache/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 端到端「接口联调」：起完整 Nest 应用 + 真 PG + 真 Redis，按真实 HTTP 调用顺序，
// 把各天做过的能力串成一条用户旅程逐段断言——认证、CRUD、缓存、分页/搜索、并发控制、
// RBAC、Token 轮换、优雅降级。和 posts / auth / oauth / security / cache 这些「按模块切片」
// 的 e2e 互补：这里验的是「拼起来整条链还对不对」。
//
// 每个用例尽量自包含（自己注册用户、建文章），不依赖别的用例的执行顺序。
// ⚠️ beforeEach 清 PG 表 + flush Redis，请指向一次性库/schema。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let redis: RedisService;
let redisAvailable = false;
let slugSeq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startApp() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  const a = await NestFactory.create(AppModule, { logger: false });
  a.enableShutdownHooks();
  await a.listen(0);
  return {
    app: a,
    baseUrl: `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`,
  };
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* 非JSON响应 */ }
  return { status: res.status, headers: res.headers, data };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(username: string): Promise<string> {
  const r = await req('POST', '/auth/register', {
    email: `${username}@e.com`, username, password: 'S3cure-pass',
  });
  return r.data?.data?.accessToken;
}

async function login(username: string) {
  const r = await req('POST', '/auth/login', {
    email: `${username}@e.com`, password: 'S3cure-pass',
  });
  return r.data?.data; // { accessToken, refreshToken, user }
}

// 注册后把 role 翻成 admin（注册默认 user）——RBAC 用例需要
async function ensureAdmin(username: string): Promise<void> {
  await register(username);
  await prisma.user.update({ where: { username }, data: { role: 'admin' } });
}

async function createPost(
  token: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number; viewCount: number; title: string }> {
  const slug = `post-${++slugSeq}`;
  const r = await req('POST', '/posts', {
    title: '默认标题', slug, content: '足够长的默认正文内容', tags: [], status: 'published',
    ...over,
  }, bearer(token));
  return r.data.data;
}

before(async () => {
  ({ app, baseUrl } = await startApp());
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  redisAvailable = await redis.ping();
});

after(async () => {
  await app?.close();
});

beforeEach(async () => {
  await prisma.postRevision.deleteMany();
  await prisma.post.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  if (redisAvailable) await redis.delByPrefix('post');
  slugSeq = 0;
});

// 缓存相关用例在 Redis 没起时整体跳过（缓存是可降级层，不该让接口联调变红）
function needRedis(t: TestContext) {
  if (!redisAvailable) t.skip('Redis 未运行，跳过缓存相关用例');
}

// ─── 健康检查 & 安全头 ─────────────────────────────────────────────────

test('健康检查：200 + 统一外壳 + Helmet 安全头', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.code, 0);
  assert.equal(r.data.data.status, 'ok');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
});

// ─── 认证 ──────────────────────────────────────────────────────────────

test('认证：注册 / me / 登录 / 重复邮箱 / 错密码不泄露用户', async () => {
  const reg = await req('POST', '/auth/register', {
    email: 'author@e.com', username: 'author', password: 'S3cure-pass',
  });
  assert.equal(reg.status, 201);
  const tok = reg.data.data.accessToken;
  assert.ok(tok);
  assert.ok(reg.data.requestId, '非 /health 响应应带 requestId');

  const me = await req('GET', '/auth/me', undefined, bearer(tok));
  assert.equal(me.status, 200);
  assert.equal(me.data.data.username, 'author');

  assert.equal((await req('GET', '/auth/me')).status, 401);

  assert.equal((await req('POST', '/auth/login', {
    email: 'author@e.com', password: 'S3cure-pass',
  })).status, 200);

  const dup = await req('POST', '/auth/register', {
    email: 'author@e.com', username: 'other', password: 'S3cure-pass',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'EMAIL_TAKEN');

  const wrong = await req('POST', '/auth/login', { email: 'author@e.com', password: 'wrong-pwd' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.code, 'INVALID_CREDENTIALS');
});

// ─── 文章校验 ──────────────────────────────────────────────────────────

test('文章校验：未登录 401 / 缺字段 400 / 重复 slug 409', async () => {
  const tok = await register('user');
  assert.equal((await req('POST', '/posts', { title: 't', slug: 's', content: 'c' })).status, 401);
  const bad = await req('POST', '/posts', { content: 'no title' }, bearer(tok));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'VALIDATION_ERROR');

  await createPost(tok, { slug: 'dup-slug' });
  const dup = await req('POST', '/posts', {
    title: 'x', slug: 'dup-slug', content: 'x'.repeat(20), status: 'draft',
  }, bearer(tok));
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'SLUG_TAKEN');
});

test('XSS：<script> 标题原样存取，响应是 JSON（API 不渲染 HTML）', async () => {
  const tok = await register('user');
  const payload = '<script>alert(1)</script>';
  const created = await createPost(tok, { title: payload, slug: 'xss' });
  const got = await req('GET', `/posts/${created.id}`);
  assert.equal(got.data.data.title, payload);
  assert.match(got.headers.get('content-type') ?? '', /application\/json/);
});

// ─── 缓存：Cache-Aside（Day 36 核心）──────────────────────────────────

test('缓存：单篇与列表 MISS→HIT，带 X-Cache-Key', async (t) => {
  needRedis(t);
  const tok = await register('user');
  const { id } = await createPost(tok);

  const list1 = await req('GET', '/posts');
  assert.equal(list1.headers.get('x-cache'), 'MISS');
  const list2 = await req('GET', '/posts');
  assert.equal(list2.headers.get('x-cache'), 'HIT');

  const one1 = await req('GET', `/posts/${id}`);
  assert.equal(one1.headers.get('x-cache'), 'MISS');
  assert.match(one1.headers.get('x-cache-key') ?? '', /^post:/);
  const one2 = await req('GET', `/posts/${id}`);
  assert.equal(one2.headers.get('x-cache'), 'HIT');
});

test('缓存穿透：不存在的 id 被负缓存（404 写哨兵），第二次不查库；非法 UUID 400', async (t) => {
  needRedis(t);
  const ghost = '00000000-0000-4000-a000-000000000000';
  const a = await req('GET', `/posts/${ghost}`);
  assert.equal(a.status, 404);
  assert.equal(a.data.code, 'POST_NOT_FOUND');
  // Day 37 穿透对策：404 后「不存在」被短缓存成哨兵，下次同一假 id 不再穿透到 DB
  const sentinel = await redis.get(`post:${ghost}`);
  assert.ok((sentinel ?? '').includes('NOT_FOUND'), `应缓存负结果哨兵，实际：${sentinel}`);
  assert.equal((await req('GET', `/posts/${ghost}`)).status, 404, '第二次命中负缓存仍 404');
  assert.equal((await req('GET', '/posts/not-a-uuid')).status, 400);
});

// ─── 分页 / 信息流 / 搜索 ──────────────────────────────────────────────

test('分页 / 信息流 / 搜索（含 SQL 注入免疫）', async () => {
  const tok = await register('user');
  await createPost(tok, { title: 'Redis 缓存实战', content: '讲 Cache-Aside' });

  const list = await req('GET', '/posts?page=1&limit=5');
  assert.ok(list.data.data.pagination.total >= 1);

  const feed = await req('GET', '/posts/feed?limit=5');
  assert.ok('hasMore' in feed.data.data.pageInfo);

  const hit = await req('GET', '/posts/search?q=' + encodeURIComponent('Redis'));
  assert.equal(hit.status, 200);
  assert.ok(hit.data.data.items.length >= 1);

  // 经典注入 payload：若被拼进 SQL，' OR '1'='1 会让 WHERE 恒真 → 返回全部；
  // 参数化下它只是个普通查询词 → 命中 0
  const inj = await req('GET', '/posts/search?q=' + encodeURIComponent("' OR '1'='1"));
  assert.equal(inj.status, 200);
  assert.equal(inj.data.data.items.length, 0);
});

// ─── 排行榜（Day 37：Sorted Set）──────────────────────────────────────

test('排行榜 GET /posts/trending：按浏览数从高到低', async (t) => {
  needRedis(t);
  await redis.del('hot:posts'); // 清掉历史榜单，确保本用例从空榜开始
  const tok = await register('user');
  const a = (await createPost(tok, { slug: 'a' })).id;
  const b = (await createPost(tok, { slug: 'b' })).id;
  const c = (await createPost(tok, { slug: 'c' })).id;
  // 浏览 A×3 / B×2 / C×1：POST /:id/view 既 +1 view_count 也给 ZSET +1 分
  for (let i = 0; i < 3; i++) await req('POST', `/posts/${a}/view`);
  for (let i = 0; i < 2; i++) await req('POST', `/posts/${b}/view`);
  await req('POST', `/posts/${c}/view`);

  const r = await req('GET', '/posts/trending?limit=3');
  assert.equal(r.status, 200);
  assert.deepEqual(
    (r.data?.data?.items ?? []).map((p: any) => p.id),
    [a, b, c],
    '应按浏览数从高到低：A(3) > B(2) > C(1)',
  );
});

// ─── 浏览计数 & 修订 ───────────────────────────────────────────────────

test('浏览计数原子 +1 & 修订历史', async () => {
  const tok = await register('user');
  const { id } = await createPost(tok);
  const before = (await req('GET', `/posts/${id}`)).data.data.viewCount;
  const after = (await req('POST', `/posts/${id}/view`)).data.data.viewCount;
  assert.equal(after, before + 1);
  const revs = await req('GET', `/posts/${id}/revisions`);
  assert.equal(revs.status, 200);
  assert.ok(Array.isArray(revs.data.data));
});

// ─── 乐观锁 & 写后失效 ─────────────────────────────────────────────────

test('乐观锁：更新自增 version；写后缓存失效、拿到最新标题', async (t) => {
  const tok = await register('user');
  const created = await createPost(tok);
  const ver = created.version;

  // 先把缓存填热（HIT）
  needRedis(t);
  await req('GET', `/posts/${created.id}`);
  assert.equal((await req('GET', `/posts/${created.id}`)).headers.get('x-cache'), 'HIT');

  const patched = await req('PATCH', `/posts/${created.id}`, { title: '新标题' }, bearer(tok));
  assert.equal(patched.status, 200);
  assert.equal(patched.data.data.title, '新标题');
  assert.equal(patched.data.data.version, ver + 1);

  // 更新后缓存应失效 → 再读 MISS 且是新标题
  const reread = await req('GET', `/posts/${created.id}`);
  assert.equal(reread.headers.get('x-cache'), 'MISS');
  assert.equal(reread.data.data.title, '新标题');

  // 用过期 version 更新 → 冲突
  const conflict = await req('PATCH', `/posts/${created.id}`, { title: 'stale', version: ver }, bearer(tok));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'VERSION_CONFLICT');
});

// ─── RBAC ──────────────────────────────────────────────────────────────

test('RBAC：非作者改/删 403；admin 改别人文章 200', async () => {
  const authorTok = await register('author');
  const { id } = await createPost(authorTok);
  const otherTok = await register('other');

  assert.equal((await req('PATCH', `/posts/${id}`, { title: '恶意' }, bearer(otherTok))).status, 403);
  assert.equal((await req('DELETE', `/posts/${id}`, undefined, bearer(otherTok))).status, 403);

  await ensureAdmin('admin');
  const adminTok = (await login('admin')).accessToken;
  assert.equal((await req('PATCH', `/posts/${id}`, { title: '管理员改的' }, bearer(adminTok))).status, 200);
});

// ─── Token 轮换 & 登出 ─────────────────────────────────────────────────

test('Refresh 轮换：旧 token 即时失效；登出后 refresh 401', async () => {
  await register('rot');
  const { refreshToken: r1 } = await login('rot');

  const refreshed = await req('POST', '/auth/refresh', { refreshToken: r1 });
  assert.equal(refreshed.status, 200);
  const r2 = refreshed.data.data.refreshToken;
  assert.notEqual(r2, r1);

  // 旧的已被轮换掉 → 401
  assert.equal((await req('POST', '/auth/refresh', { refreshToken: r1 })).status, 401);

  // 登出撤销 r2
  assert.equal((await req('POST', '/auth/logout', { refreshToken: r2 })).status, 200);
  assert.equal((await req('POST', '/auth/refresh', { refreshToken: r2 })).status, 401);
});

// ─── 删除 & 删除后失效 ─────────────────────────────────────────────────

test('删除：作者删除 200，删除后再读 404', async () => {
  const tok = await register('user');
  const { id } = await createPost(tok);
  assert.equal((await req('DELETE', `/posts/${id}`, undefined, bearer(tok))).status, 200);
  assert.equal((await req('GET', `/posts/${id}`)).status, 404);
});

// ─── 优雅降级（Day 36 核心：Redis 掉线系统不挂）──────────────────────

test('优雅降级：停 Redis → 接口仍 200 且 X-Cache=BYPASS，恢复后重新 MISS', async (t) => {
  needRedis(t);
  // 这条用例需要能控制 redis 容器；没有 docker 就跳过（不阻断其它用例）
  let canDocker = false;
  try { execSync('docker ps', { stdio: 'ignore' }); canDocker = true; } catch { /* 无 docker */ }
  if (!canDocker) return t.skip('无 docker，跳过降级用例');

  const tok = await register('user');
  const { id } = await createPost(tok);
  await req('GET', `/posts/${id}`); // 回填缓存

  try {
    execSync('docker stop redis-blog', { stdio: 'ignore' });
    await sleep(1200);
    const down = await req('GET', `/posts/${id}`);
    assert.equal(down.status, 200, 'Redis 停了，接口必须照常返回');
    assert.equal(down.headers.get('x-cache'), 'BYPASS', '缓存层不通时应绕过 → BYPASS');
  } finally {
    // 无论如何把 Redis 拉回来，别影响后面的用例 / 别人的开发环境
    try { execSync('docker start redis-blog', { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(2500);
  }

  const up = await req('GET', `/posts/${id}`);
  assert.ok(['MISS', 'HIT'].includes(up.headers.get('x-cache') ?? ''), 'Redis 恢复后应重新走缓存');
});
