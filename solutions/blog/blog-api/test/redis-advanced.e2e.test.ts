import 'reflect-metadata';
import { test, before, after, beforeEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { RedisLockService } from '../src/cache/redis-lock.service';
import { RedisService } from '../src/cache/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TrendingService } from '../src/posts/trending.service';

// Day 37 进阶测试：排行榜（Sorted Set）、分布式锁（SET NX EX + Lua 释放）、
// 缓存穿透（负缓存）。起完整 Nest 应用 + 真 PG + 真 Redis。
// Redis 没起时，缓存/锁/榜相关用例各自 skip（不拖红整套）。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let redis: RedisService;
let locks: RedisLockService;
let trending: TrendingService;
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
  locks = app.get(RedisLockService);
  trending = app.get(TrendingService);
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
  if (redisAvailable) {
    await redis.delByPrefix('post'); // 清 post:* 缓存 + 负缓存哨兵
    await trending.reset(); // 清排行榜 ZSET
  }
});

function needRedis(t: TestContext) {
  if (!redisAvailable) t.skip('Redis 未运行，跳过 Redis 进阶用例');
}

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* 非JSON */ }
  return { status: res.status, headers: res.headers, data };
}

async function register(username: string): Promise<string> {
  const r = await req('POST', '/auth/register', {
    email: `${username}@e.com`, username, password: 'S3cure-pass',
  });
  return r.data?.data?.accessToken;
}

async function createPost(token: string, slug: string): Promise<string> {
  const r = await req('POST', '/posts', {
    title: `t-${slug}`, slug, content: '足够长的默认正文内容', tags: [], status: 'published',
  }, { Authorization: `Bearer ${token}` });
  return r.data.data.id;
}

// ─── 排行榜（Sorted Set）──────────────────────────────────────────────

test('排行榜：按浏览数排序，ZSET 驱动', async (t) => {
  needRedis(t);
  const tok = await register('user');
  const a = await createPost(tok, 'a');
  const b = await createPost(tok, 'b');
  const c = await createPost(tok, 'c');

  // 浏览 A×3、B×2、C×1：POST /:id/view 既 +1 view_count（DB）也 ZINCRBY +1（ZSET）
  for (let i = 0; i < 3; i++) await req('POST', `/posts/${a}/view`);
  for (let i = 0; i < 2; i++) await req('POST', `/posts/${b}/view`);
  await req('POST', `/posts/${c}/view`);

  const r = await req('GET', '/posts/trending?limit=3');
  assert.equal(r.status, 200);
  const ids = (r.data?.data?.items ?? []).map((p: any) => p.id);
  assert.deepEqual(ids, [a, b, c], '应按浏览数从高到低：A(3) > B(2) > C(1)');
});

test('排行榜兜底：ZSET 为空时回退 DB 按 view_count', async (t) => {
  needRedis(t);
  const tok = await register('user');
  const a = await createPost(tok, 'a');
  const b = await createPost(tok, 'b');
  // A 浏览 2 次（会顺手写 ZSET），然后清空 ZSET，模拟「榜还没建起来 / 刚重启」
  await req('POST', `/posts/${a}/view`);
  await req('POST', `/posts/${a}/view`);
  await trending.reset();

  const r = await req('GET', '/posts/trending');
  assert.equal(r.status, 200);
  const ids = (r.data?.data?.items ?? []).map((p: any) => p.id);
  assert.deepEqual(ids, [a, b], 'ZSET 空 → 走 DB ORDER BY view_count：A(2) 在前');
});

// ─── 分布式锁（SET NX EX + Lua 安全释放）──────────────────────────────

test('分布式锁：互斥 + 只删自己的锁', async (t) => {
  needRedis(t);
  const key = 'lock:test:1';
  // 抢到
  const t1 = await locks.acquire(key, 5);
  assert.ok(t1, '第一次应抢到锁');
  // 互斥：同一把锁再抢 → null
  const t2 = await locks.acquire(key, 5);
  assert.equal(t2, null, '锁被占时第二次应抢不到');
  // 错误 token 释放不了（Lua 比对失败）——模拟「别的进程拿错 token 想释放」
  await locks.release(key, 'wrong-token');
  const t3 = await locks.acquire(key, 5);
  assert.equal(t3, null, '用错误 token 释放无效，锁仍被占');
  // 正确 token 释放后可重新抢到
  await locks.release(key, t1);
  const t4 = await locks.acquire(key, 5);
  assert.ok(t4, '正确释放后应能重新抢到');
  await locks.release(key, t4);
});

// ─── 缓存穿透（负缓存）────────────────────────────────────────────────

test('穿透对策：不存在的 id 被负缓存，第二次不查库', async (t) => {
  needRedis(t);
  const ghost = '00000000-0000-4000-a000-000000000000';
  const first = await req('GET', `/posts/${ghost}`);
  assert.equal(first.status, 404);
  // 负缓存哨兵应已写入——证明「不存在」被缓存了，下次同一假 id 不会再穿透到 DB
  const sentinel = await redis.get(`post:${ghost}`);
  assert.ok(
    (sentinel ?? '').includes('NOT_FOUND'),
    `404 后应缓存负结果哨兵，实际：${sentinel}`,
  );
  // 第二次依旧 404（命中负缓存）
  const second = await req('GET', `/posts/${ghost}`);
  assert.equal(second.status, 404);
});
