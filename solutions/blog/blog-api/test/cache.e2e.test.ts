import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { RedisService } from '../src/cache/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Day 36 缓存集成测试：起完整 Nest 应用 + 真 PG + 真 Redis，验证 Cache-Aside 的四件事——
//  1. 命中：首次读 X-Cache=MISS 并回填，再读 X-Cache=HIT
//  2. 失效：更新 / 删除后，对应缓存被清掉，下次读重新 MISS 并反映最新数据
//  3. 列表缓存：同查询第二次 HIT；新建文章后列表失效、重新 MISS
//  4. 负结果不缓存：查不存在的 id 两次都 404（不会把 404 缓存成「假文章」）
//
// 如果测试环境没起 Redis，整套用例会 skip（而不是 fail）——缓存是可降级层，不该让测试红。
// ⚠️ beforeEach 清 PG 表 + flush Redis，请指向一次性库/schema。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let redis: RedisService;
let redisAvailable = false;

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

before(async () => {
  ({ app, baseUrl } = await startApp());
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  // 探活：Redis 没起就标记不可用，下面每个用例自行 skip。
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
  // 清掉所有 post* 缓存键（post:<id> 与 posts:list:* 都以 'post' 开头，一次扫干净）
  if (redisAvailable) await redis.delByPrefix('post');
});

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
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    headers: res.headers,
  };
}

async function registerToken(email: string, username: string) {
  const r = await req('POST', '/auth/register', { email, username, password: 'S3cure-pass' });
  return { authorization: `Bearer ${r.json.data.accessToken}` };
}

// 造一篇已发布文章，返回它的 id
async function seedPost(auth: Record<string, string>, slug: string, title: string) {
  const r = await req('POST', '/posts', {
    title,
    slug,
    content: '一篇关于缓存的文章正文，足够长能过校验',
    tags: [],
    status: 'published',
  }, auth);
  return r.json.data.id as string;
}

// ─── 1. 单篇缓存：MISS → HIT ──────────────────────────────────────────

test('单篇读：首次 MISS 回填，第二次 HIT', async (t) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过缓存用例');
  const auth = await registerToken('cache1@example.com', 'cache1');
  const id = await seedPost(auth, 'cache-hit', '缓存命中测试');

  const first = await req('GET', `/posts/${id}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), 'MISS', '首次读应未命中、回填缓存');

  const second = await req('GET', `/posts/${id}`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-cache'), 'HIT', '第二次读应命中缓存');
  // 命中后内容应与首次一致（含正确反序列化的字段）
  assert.equal(second.json.data.id, id);
  assert.equal(second.json.data.title, '缓存命中测试');
});

// ─── 2. 更新后失效：缓存被清，下次读反映新数据 ─────────────────────────

test('更新文章后单篇缓存失效：再读为 MISS 且拿到最新标题', async (t) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过缓存用例');
  const auth = await registerToken('cache2@example.com', 'cache2');
  const id = await seedPost(auth, 'cache-invalidate', '原标题');

  // 先填上缓存（HIT）
  await req('GET', `/posts/${id}`);
  const warm = await req('GET', `/posts/${id}`);
  assert.equal(warm.headers.get('x-cache'), 'HIT');

  // 更新：触发失效
  const patched = await req('PATCH', `/posts/${id}`, { title: '新标题' }, auth);
  assert.equal(patched.status, 200);

  // 再读：应为 MISS（缓存已失效）且拿到新标题——证明失效成功，没返回陈旧缓存
  const after = await req('GET', `/posts/${id}`);
  assert.equal(after.headers.get('x-cache'), 'MISS', '更新后缓存应被清掉');
  assert.equal(after.json.data.title, '新标题', '失效后再读应反映最新数据');
});

// ─── 3. 删除后失效：再读 404 ────────────────────────────────────────────

test('删除文章后单篇缓存失效：再读 404', async (t) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过缓存用例');
  const auth = await registerToken('cache3@example.com', 'cache3');
  const id = await seedPost(auth, 'cache-delete', '待删除');

  await req('GET', `/posts/${id}`); // 回填缓存
  const warm = await req('GET', `/posts/${id}`);
  assert.equal(warm.headers.get('x-cache'), 'HIT');

  const removed = await req('DELETE', `/posts/${id}`, undefined, auth);
  assert.equal(removed.status, 200);

  const after = await req('GET', `/posts/${id}`);
  assert.equal(after.status, 404, '删除并失效后应 404，而不是返回陈旧缓存');
});

// ─── 4. 列表缓存：MISS → HIT；新建后失效 ───────────────────────────────

test('列表读：第二次 HIT；新建文章后列表失效、重新 MISS 并含新文章', async (t) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过缓存用例');
  const auth = await registerToken('cache4@example.com', 'cache4');
  await seedPost(auth, 'list-a', '文章A');

  const first = await req('GET', '/posts');
  assert.equal(first.headers.get('x-cache'), 'MISS');
  assert.equal((first.json.data.items ?? []).length, 1);

  const warm = await req('GET', '/posts');
  assert.equal(warm.headers.get('x-cache'), 'HIT', '同查询第二次应命中');

  // 新建 → 列表缓存全清
  await seedPost(auth, 'list-b', '文章B');

  const after = await req('GET', '/posts');
  assert.equal(after.headers.get('x-cache'), 'MISS', '新建后列表缓存应失效');
  assert.equal((after.json.data.items ?? []).length, 2, '失效重读应含新文章');
});

// ─── 5. 负结果不缓存：不存在的 id 两次都 404 ───────────────────────────

test('查不存在的 id：每次都 404，不把 404 缓存成"假文章"', async (t) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过缓存用例');
  const ghost = '00000000-0000-4000-a000-000000000000';
  const a = await req('GET', `/posts/${ghost}`);
  assert.equal(a.status, 404);
  const b = await req('GET', `/posts/${ghost}`);
  assert.equal(b.status, 404, '负结果不缓存：第二次依旧真正查库并 404');
  // 404 路径不写 X-Cache（findOne 在 loadById 抛错前就冒泡了）
  assert.equal(a.headers.get('x-cache'), null);
});
