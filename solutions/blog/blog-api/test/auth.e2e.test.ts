import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// 集成测试：起完整 Nest 应用 + 真 PG，跑注册→登录→me→刷新→登出全链路。
// ⚠️ beforeEach 会清空 users / refresh_tokens，请指向一次性库/schema。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;

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
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

const validReg = (over: Record<string, unknown> = {}) => ({
  email: 'alice@example.com',
  username: 'alice',
  password: 'S3cure-pass',
  ...over,
});

// ─── 注册 ────────────────────────────────────────────────────────────

test('register → 201 + access/refresh + user（绝不含 password）', async () => {
  const r = await req('POST', '/auth/register', validReg());
  assert.equal(r.status, 201);
  assert.equal(r.json.code, 0);
  assert.ok(r.json.data.accessToken);
  assert.ok(r.json.data.refreshToken);
  assert.equal(r.json.data.tokenType, 'Bearer');
  assert.equal(r.json.data.user.email, 'alice@example.com');
  assert.equal(r.json.data.user.role, 'user');
  assert.equal(r.json.data.user.password, undefined, '响应里绝不能出现 password');
});

test('register 重复 email → 409 EMAIL_TAKEN', async () => {
  await req('POST', '/auth/register', validReg());
  const r = await req('POST', '/auth/register', validReg({ username: 'other' }));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'EMAIL_TAKEN');
});

test('register 重复 username → 409 USERNAME_TAKEN', async () => {
  await req('POST', '/auth/register', validReg());
  const r = await req('POST', '/auth/register', validReg({ email: 'other@example.com' }));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'USERNAME_TAKEN');
});

test('register 弱密码（<8）→ 400 VALIDATION_ERROR', async () => {
  const r = await req('POST', '/auth/register', validReg({ password: 'short' }));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
});

// ─── 登录 ────────────────────────────────────────────────────────────

test('login 正确 → 200 + tokens', async () => {
  await req('POST', '/auth/register', validReg());
  const r = await req('POST', '/auth/login', {
    email: 'alice@example.com',
    password: 'S3cure-pass',
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.accessToken);
});

test('login 密码错 → 401 INVALID_CREDENTIALS', async () => {
  await req('POST', '/auth/register', validReg());
  const r = await req('POST', '/auth/login', {
    email: 'alice@example.com',
    password: 'wrong-pass',
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'INVALID_CREDENTIALS');
});

test('login 不存在的邮箱 → 401 INVALID_CREDENTIALS（不暴露是否注册）', async () => {
  const r = await req('POST', '/auth/login', {
    email: 'nobody@example.com',
    password: 'whatever',
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'INVALID_CREDENTIALS');
});

// ─── /me（受保护）─────────────────────────────────────────────────────

test('me 带有效 access token → 200 当前用户', async () => {
  const reg = await req('POST', '/auth/register', validReg());
  const r = await req('GET', '/auth/me', undefined, {
    authorization: `Bearer ${reg.json.data.accessToken}`,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.email, 'alice@example.com');
  assert.equal(r.json.data.password, undefined);
});

test('me 不带 token → 401 UNAUTHORIZED', async () => {
  const r = await req('GET', '/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
});

test('me 乱 token → 401', async () => {
  const r = await req('GET', '/auth/me', undefined, { authorization: 'Bearer garbage' });
  assert.equal(r.status, 401);
});

// ─── 刷新 / 轮换 / 登出 ───────────────────────────────────────────────

test('refresh → 新 token，且旧 refresh 被轮换作废', async () => {
  const reg = await req('POST', '/auth/register', validReg());
  const oldRefresh = reg.json.data.refreshToken;

  const r1 = await req('POST', '/auth/refresh', { refreshToken: oldRefresh });
  assert.equal(r1.status, 200);
  assert.ok(r1.json.data.accessToken);
  assert.notEqual(r1.json.data.refreshToken, oldRefresh, '应轮换出新的 refresh');

  // 旧 refresh 已作废，再用 → 401
  const r2 = await req('POST', '/auth/refresh', { refreshToken: oldRefresh });
  assert.equal(r2.status, 401);
  assert.equal(r2.json.code, 'INVALID_REFRESH_TOKEN');
});

test('logout → 作废 refresh，登出后再 refresh → 401', async () => {
  const reg = await req('POST', '/auth/register', validReg());
  const refresh = reg.json.data.refreshToken;

  const lo = await req('POST', '/auth/logout', { refreshToken: refresh });
  assert.equal(lo.status, 200);
  assert.equal(lo.json.data.success, true);

  const r = await req('POST', '/auth/refresh', { refreshToken: refresh });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'INVALID_REFRESH_TOKEN');
});

test('refresh 乱 token → 401 INVALID_REFRESH_TOKEN', async () => {
  const r = await req('POST', '/auth/refresh', { refreshToken: 'not-a-real-token' });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'INVALID_REFRESH_TOKEN');
});

// ─── Day 33：admin-only（@Roles + RolesGuard）────────────────────────

test('GET /auth/users：不带 token → 401 UNAUTHORIZED', async () => {
  const r = await req('GET', '/auth/users');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'UNAUTHORIZED');
});

test('GET /auth/users：普通用户 → 403 FORBIDDEN', async () => {
  const reg = await req('POST', '/auth/register', validReg());
  const r = await req('GET', '/auth/users', undefined, {
    authorization: `Bearer ${reg.json.data.accessToken}`,
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'FORBIDDEN');
});

test('GET /auth/users：admin → 200 用户列表（不含 password）', async () => {
  const reg = await req('POST', '/auth/register', validReg());
  // 提到 admin 再重新登录拿带 admin 角色的 token
  await prisma.user.update({
    where: { id: reg.json.data.user.id },
    data: { role: 'admin' },
  });
  const login = await req('POST', '/auth/login', {
    email: validReg().email,
    password: validReg().password,
  });
  const r = await req('GET', '/auth/users', undefined, {
    authorization: `Bearer ${login.json.data.accessToken}`,
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.data));
  assert.ok(r.json.data.length >= 1);
  assert.equal(r.json.data[0].password, undefined, '不能泄露 password');
});
