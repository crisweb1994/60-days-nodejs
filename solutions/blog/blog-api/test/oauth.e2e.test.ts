import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  GithubOAuthProvider,
  type GithubUser,
} from '../src/auth/oauth/github-oauth.provider';

// 集成测试：起完整 Nest 应用 + 真 PG，跑 GitHub OAuth 授权码全链路。
// ★ 不真正打 GitHub：拿到 provider 单例后，把"换 token / 拉资料"两个出网方法替换成假的，
//   只验证我们自己的逻辑（state 校验、建号/绑定、发本系统 token）。
// ⚠️ beforeEach 会清空 users / refresh_tokens，请指向一次性库/schema。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let github: GithubOAuthProvider;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.PAGE_LIMIT = '20';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
  // ★ 让 isConfigured() 为真，/auth/github 才会 302 而不是 503
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
  process.env.GITHUB_CALLBACK_URL ??= 'http://localhost:3000/auth/github/callback';

  app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
  github = app.get(GithubOAuthProvider);
});

after(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  // 删除实例上覆盖的方法 → 回落到原型方法（清掉上个用例的 monkey-patch）
  delete (github as any).exchangeCodeForToken;
  delete (github as any).fetchGithubUser;
  delete (github as any).isConfigured;
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

// 把"出网"两步换成假的，只喂一个固定的 GitHub 用户
function fakeGithubUser(user: GithubUser) {
  (github as any).exchangeCodeForToken = async () => 'fake-github-token';
  (github as any).fetchGithubUser = async () => user;
}

// 发起授权 → 从 302 Location 里取出我们生成的 state
async function obtainState(): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
  assert.equal(res.status, 302, '应 302 跳转');
  const loc = res.headers.get('location');
  assert.ok(loc, '应带 Location');
  const state = new URL(loc as string).searchParams.get('state');
  assert.ok(state, '授权 URL 应带 state');
  return state as string;
}

// ─── 发起授权 ─────────────────────────────────────────────────────────

test('GET /auth/github → 302 跳到 GitHub 授权页（带 client_id/scope/state）', async () => {
  const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location') as string);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.match(url.searchParams.get('scope') ?? '', /user/);
  assert.ok(url.searchParams.get('state'), '应带 state');
});

test('未配置 OAuth → GET /auth/github 返回 503 OAUTH_NOT_CONFIGURED', async () => {
  (github as any).isConfigured = () => false;
  const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'OAUTH_NOT_CONFIGURED');
});

// ─── 回调全链路 ───────────────────────────────────────────────────────

test('回调全链路：换 token → 拉资料 → 建号 → 发本系统 token（可用于 /me）', async () => {
  const state = await obtainState();
  fakeGithubUser({ id: '424242', login: 'octocat', name: 'Octo', email: 'octo@example.com' });

  const r = await req('GET', `/auth/github/callback?code=fake-code&state=${state}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
  assert.ok(r.json.data.accessToken);
  assert.ok(r.json.data.refreshToken);
  assert.equal(r.json.data.tokenType, 'Bearer');
  assert.equal(r.json.data.user.email, 'octo@example.com');
  assert.equal(r.json.data.user.username, 'octocat');
  assert.equal(r.json.data.user.password, undefined, '绝不能返回 password');

  // 发的 access token 应能访问受保护接口
  const me = await req('GET', '/auth/me', undefined, {
    authorization: `Bearer ${r.json.data.accessToken}`,
  });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.email, 'octo@example.com');
});

test('回调重复使用同一个 state → 401 OAUTH_STATE_INVALID（防重放）', async () => {
  const state = await obtainState();
  fakeGithubUser({ id: '111', login: 'a', name: null, email: 'a@example.com' });

  const ok = await req('GET', `/auth/github/callback?code=c&state=${state}`);
  assert.equal(ok.status, 200);

  const again = await req('GET', `/auth/github/callback?code=c&state=${state}`);
  assert.equal(again.status, 401);
  assert.equal(again.json.code, 'OAUTH_STATE_INVALID');
});

test('回调 state 缺失或伪造 → 401 OAUTH_STATE_INVALID（防 CSRF）', async () => {
  fakeGithubUser({ id: '1', login: 'x', name: null, email: 'x@example.com' });

  const noState = await req('GET', '/auth/github/callback?code=c');
  assert.equal(noState.status, 401);
  assert.equal(noState.json.code, 'OAUTH_STATE_INVALID');

  const fake = await req('GET', '/auth/github/callback?code=c&state=deadbeefdeadbeef');
  assert.equal(fake.status, 401);
  assert.equal(fake.json.code, 'OAUTH_STATE_INVALID');
});

test('回调带 error（用户在 GitHub 拒绝授权）→ 401 OAUTH_FAILED', async () => {
  const r = await req(
    'GET',
    '/auth/github/callback?error=access_denied&error_description=The+user+denied',
  );
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'OAUTH_FAILED');
});

// ─── 建号 / 绑定 策略 ─────────────────────────────────────────────────

test('OAuth 邮箱命中已注册账号 → 绑定到该账号（不新建）', async () => {
  const reg = await req('POST', '/auth/register', {
    email: 'alice@example.com',
    username: 'alice',
    password: 'S3cure-pass',
  });
  const aliceId = reg.json.data.user.id;

  const state = await obtainState();
  fakeGithubUser({ id: '7777', login: 'alice-gh', name: 'Alice', email: 'alice@example.com' });
  const r = await req('GET', `/auth/github/callback?code=c&state=${state}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.user.id, aliceId, '应复用同一账号');

  const dbUser = await prisma.user.findUnique({ where: { id: aliceId } });
  assert.equal(dbUser?.githubId, '7777', '应把 githubId 绑到老账号上');
  assert.equal(await prisma.user.count(), 1, '不应新建账号');
});

test('同一 GitHub 账号二次登录 → 复用账号（按 githubId 命中，幂等）', async () => {
  const gh: GithubUser = { id: '8888', login: 'bob', name: 'Bob', email: 'bob@example.com' };

  const s1 = await obtainState();
  fakeGithubUser(gh);
  const first = await req('GET', `/auth/github/callback?code=c&state=${s1}`);

  const s2 = await obtainState();
  fakeGithubUser(gh);
  const second = await req('GET', `/auth/github/callback?code=c&state=${s2}`);

  assert.equal(first.json.data.user.id, second.json.data.user.id);
  assert.equal(await prisma.user.count(), 1);
});
