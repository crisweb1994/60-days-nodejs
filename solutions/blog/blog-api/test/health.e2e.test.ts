import 'reflect-metadata';
import { test, before, after, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { RedisService } from '../src/cache/redis.service';

// 两条探针的端到端验证：/health（存活，进程级）vs /health/ready（就绪，查 DB + Redis）。
// 重点验「语义差异」——就绪探针在缓存层掉线时返回 503、而存活探针仍 200，
// 这正是编排器（compose depends_on / k8s）区分「进程在不在」与「能不能接流量」的依据。

let app: INestApplication;
let baseUrl: string;
let redisAvailable = false;

async function startApp() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api';
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

async function req(method: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { method });
  let data: any = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应兜底 */
  }
  return { status: res.status, data };
}

function needRedis(t: TestContext) {
  if (!redisAvailable) t.skip('Redis 未运行，跳过就绪-200 用例');
}

before(async () => {
  ({ app, baseUrl } = await startApp());
  redisAvailable = await app.get(RedisService).ping();
});

after(async () => {
  await app?.close();
});

test('存活探针 /health：200 + status ok，不依赖 Redis', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.data.status, 'ok');
  assert.equal(typeof r.data.data.uptime, 'number');
});

test('就绪探针 /health/ready：DB + Redis 都在时 200，details 列出 database/redis', async (t) => {
  needRedis(t);
  const r = await req('GET', '/health/ready');
  assert.equal(r.status, 200);
  assert.equal(r.data.data.status, 'ok');
  assert.equal(r.data.data.details.database.status, 'up');
  assert.equal(r.data.data.details.redis.status, 'up');
});

test('就绪 vs 存活：Redis 掉线时 /health/ready 返回 503，而 /health 仍 200', async (t) => {
  needRedis(t);
  // 模拟「缓存层掉线」：把本 app 的 RedisService 底层连接主动断开。
  // 注意这【只】影响 RedisHealthIndicator（它走 RedisService.ping→client）；BullMQ 的 worker
  // 用自己独立的连接（MailProcessor 从 config.redis.url 另建），不受影响——符合真实掉线场景。
  const client = (app.get(RedisService) as unknown as {
    client: { quit: () => Promise<void> };
  }).client;
  await client.quit();
  // ioredis quit 是优雅关闭：等在途命令收完再断。给它一拍让 status 翻成 'end'。
  await new Promise((r) => setTimeout(r, 80));

  const liveness = await req('GET', '/health');
  assert.equal(liveness.status, 200, '存活探针不该因缓存掉线而变红');

  const ready = await req('GET', '/health/ready');
  // 503 响应体按错误外壳包成 { code:503, data:null, ... }——details 在异常里被过滤器丢了，
  // 所以这里只断状态码。DB 仍就绪是确定的：app 能 bootstrap 就证明 Prisma 连上了（PrismaService
  // fail-fast）；本用例唯一的变量是刚断开的 Redis，故 503 的成因被隔离为缓存层掉线。
  assert.equal(ready.status, 503, '就绪探针应在缓存层掉线时返回 503');
  assert.equal(ready.data.data, null, '错误外壳 data 应为 null');
});
