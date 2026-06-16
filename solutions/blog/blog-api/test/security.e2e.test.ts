import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Day 35 安全防护集成测试：起完整 Nest 应用 + 真 PG，验证四件事——
//  1. Helmet 安全响应头（X-Content-Type-Options / X-Frame-Options …）
//  2. 限流：登录路径 @Throttle(30) → 连打超阈值后 429 RATE_LIMITED（测真实的认证限流，
//     不依赖 env——@Throttle 是装饰器写死的，不受 @nestjs/config 进程内只校验一次的影响）
//  3. SQL 注入：搜索走参数化查询，恶意 payload 既不报错也不会被当成 SQL 拼接（不会"越权返回全部行"）
//  4. XSS：内容原样存、原样取（API 不渲染 HTML，输出转义是消费方——前端——的责任）
// ⚠️ beforeEach 清表，请指向一次性库/schema。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;

// 起一个应用。注意：@nestjs/config 的 validate 在一个进程里只跑一次（首个应用初始化时烘焙配置），
// 所以不能靠"换个应用实例 + 改 env"来调限流阈值——限流用例改走 @Throttle 这条与 env 无关的路径。
async function startApp() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';

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
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.postRevision.deleteMany();
  await prisma.post.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
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

// 注册一个用户，返回 Authorization 头
async function registerToken(email: string, username: string) {
  const r = await req('POST', '/auth/register', {
    email,
    username,
    password: 'S3cure-pass',
  });
  return { authorization: `Bearer ${r.json.data.accessToken}` };
}

// ─── Helmet 安全头 ─────────────────────────────────────────────────────

test('响应带 Helmet 安全头：禁止 MIME 嗅探 + 防点击劫持', async () => {
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  // nosniff：禁止浏览器把 JSON 当 HTML 猜（MIME 嗅探是反射型 XSS 的帮凶）
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // SAMEORIGIN：别站不能用 <iframe> 套我们（点击劫持 clickjacking）
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
});

// ─── 限流 ──────────────────────────────────────────────────────────────

test('认证接口连打超 @Throttle(30) → 429 RATE_LIMITED（带 Retry-After）', async () => {
  // 用 /auth/refresh 连打：它不带 bcrypt（只 sha256 + 查库），快；且它在 AuthController 的
  // @Throttle(30) 覆盖下，与全局限流阈值（env，进程内只校验一次）无关，结果稳定。
  // 前 30 次返回 401（refresh 无效），第 31 次起被限流成 429。
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) {
    const r = await req('POST', '/auth/refresh', { refreshToken: 'not-a-real-token' });
    codes.push(r.status);
  }
  // 前 30 次都应是 401（INVALID_REFRESH_TOKEN），不该被限流
  assert.ok(
    codes.slice(0, 30).every((c) => c === 401),
    `前 30 次应为 401，实际: ${codes.slice(0, 30).join(',')}`,
  );
  // 第 31 次被限流
  assert.equal(codes[30], 429, '第 31 次应被限流成 429');

  const blocked = await req('POST', '/auth/refresh', { refreshToken: 'still-not-real' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, 'RATE_LIMITED', '应映射成业务码 RATE_LIMITED');
  assert.equal(blocked.json.message, '请求过于频繁，请稍后再试');
  assert.ok(blocked.headers.get('retry-after'), '被限流时应带 Retry-After 告诉客户端等多久');
});

// ─── SQL 注入：参数化查询天然免疫 ──────────────────────────────────────

test('搜索恶意 payload 不会被当成 SQL：不报错、不"越权返回全部行"', async () => {
  const auth = await registerToken('sqli@example.com', 'sqli');
  // 种 2 篇文章，内容里都不含注入 payload 的词
  await req('POST', '/posts', {
    title: 'NestJS 安全实践', slug: 'a',
    content: '讲讲参数化查询和 websearch_to_tsquery', tags: [], status: 'published',
  }, auth);
  await req('POST', '/posts', {
    title: 'Express 进阶', slug: 'b',
    content: '中间件与错误处理', tags: [], status: 'published',
  }, auth);

  // 正常搜索能命中
  const legit = await req('GET', '/posts/search?q=' + encodeURIComponent('NestJS'));
  assert.equal(legit.status, 200);
  assert.ok((legit.json.data?.items ?? []).length >= 1, '正常关键词应能搜到');

  // 经典注入 payload：如果拼接了 SQL，' OR '1'='1 会让 WHERE 恒真 → 返回全部 2 条
  const payloads = ["' OR '1'='1", "'; DROP TABLE posts; --", "' UNION SELECT * FROM users; --"];
  for (const q of payloads) {
    const r = await req('GET', '/posts/search?q=' + encodeURIComponent(q));
    assert.equal(r.status, 200, `payload "${q}" 不应导致非 200（更不会 DROP/UNION）`);
    const hits = r.json.data?.items ?? [];
    assert.equal(hits.length, 0, `payload "${q}" 应被当普通查询词，命中 0 条而非全部`);
  }
});

// ─── XSS：API 不渲染 HTML，输出转义是前端的事 ─────────────────────────

test('含 <script> 的内容原样存取：API 不解释 HTML、也不擅自改写', async () => {
  const auth = await registerToken('xss@example.com', 'xss');
  const payload = '<script>alert("xss")</script>';
  const created = await req('POST', '/posts', {
    title: payload,
    slug: 'xss-post',
    content: `${payload} 正文凑够十个字符以上才过校验`,
    tags: [],
    status: 'draft',
  }, auth);
  assert.equal(created.status, 201);
  // 内容应原样保存，不被服务端"清洗"或"执行"——清洗是消费方渲染时的职责
  assert.equal(created.json.data.title, payload);

  const got = await req('GET', `/posts/${created.json.data.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.title, payload);
  // 响应是 JSON：浏览器不会把 JSON 字段里的 <script> 当 HTML 执行
  assert.match(got.headers.get('content-type') ?? '', /application\/json/);
});
