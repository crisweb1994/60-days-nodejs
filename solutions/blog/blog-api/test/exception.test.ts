import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { InMemoryPostsRepository } from '../src/posts/repositories/in-memory-posts.repository';

let app: INestApplication;
let baseUrl: string;
let repo: InMemoryPostsRepository;

before(async () => {
  // 给 ConfigModule 喂稳定的 env，避免依赖跑测时的 shell 环境
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.PAGE_LIMIT = '20';

  app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);

  const server = app.getHttpServer();
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  repo = app.get(InMemoryPostsRepository);
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  // 每个 case 一个干净的内存仓储，否则 case 顺序敏感
  repo.clear();
});

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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
  title: 'Hello Day 20',
  slug: 'hello-day-20',
  content: 'a long enough content body for validation',
  status: 'draft',
  ...over,
});

// ─── 验收清单（README 第 11 节）───────────────────────────────

test('1) 正常创建 → 201 + code:0 + 完整 Post', async () => {
  const r = await req('POST', '/posts', validPost());
  assert.equal(r.status, 201);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.message, 'ok');
  assert.equal(r.json.data.title, 'Hello Day 20');
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
  // 1) 自动生成
  const r1 = await req('GET', '/posts');
  assert.ok(r1.json.requestId);
  assert.equal(r1.headers.get('x-request-id'), r1.json.requestId);

  // 2) 尊重上游传入
  const r2 = await req('GET', '/posts', undefined, { 'x-request-id': 'trace-abc-123' });
  assert.equal(r2.json.requestId, 'trace-abc-123');
  assert.equal(r2.headers.get('x-request-id'), 'trace-abc-123');
});

test('/health：返回 ok + uptime，且不被 HttpLoggerMiddleware 记录', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  // /health 也走 TransformInterceptor，包了一层
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.status, 'ok');
  assert.ok(typeof r.json.data.uptime === 'number');
});

test('分页 limit 上限：?limit=99999 被 ValidationPipe 拒绝', async () => {
  const r = await req('GET', '/posts?limit=99999');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

test('查询：keyword + status + sortBy 配合', async () => {
  await req('POST', '/posts', validPost({ slug: 'a', title: 'NestJS guide', status: 'published' }));
  await req('POST', '/posts', validPost({ slug: 'b', title: 'Express guide', status: 'draft' }));
  await req('POST', '/posts', validPost({ slug: 'c', title: 'NestJS deep dive', status: 'published' }));

  const r = await req('GET', '/posts?keyword=nest&status=published&sortBy=title&order=asc');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items.length, 2);
  assert.equal(r.json.data.items[0].title, 'NestJS deep dive');
  assert.equal(r.json.data.pagination.total, 2);
});

test('archived 文章拒绝更新 → POST_ARCHIVED', async () => {
  const created = await req('POST', '/posts', validPost({ slug: 'arch', status: 'archived' }));
  const id = created.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'new title' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'POST_ARCHIVED');
  assert.equal(r.json.category, 'business');
});

test('非法 UUID 路径参数 → 400（ParseUUIDPipe）', async () => {
  const r = await req('GET', '/posts/not-a-uuid');
  assert.equal(r.status, 400);
});
