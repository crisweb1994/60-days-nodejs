import 'reflect-metadata';
import { test, before, after, beforeEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { LoginAttemptService } from '../src/cache/login-attempt.service';
import { RedisService } from '../src/cache/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { AppConfig } from '../src/config/configuration';

// Day 40 安全加固集成测试：起完整 Nest 应用 + 真 PG，验证三件事——
//  1. 账号锁定：同一账号连续登录失败达阈值后，连【正确密码】也登不进（423 ACCOUNT_LOCKED）。
//     这是按【账号】的爆破防护，和 Day 35 按【IP】的限流正交。Redis 没起时 skip（锁定是可选层）。
//  2. 成功登录清零：失败计数被一次成功抹掉，否则合法用户偶发手滑几次后会被锁。
//  3. 密码强度策略：注册期拒绝弱密码（单一类别 / 常见密码），强密码通过。无需 Redis。
//  4. 请求体上限：超过 JSON 体积上限的 payload 在解析阶段就被拒成 413 BODY_TOO_LARGE。无需 Redis。
// ⚠️ beforeEach 清 PG 表；锁定计数落在【共享 Redis】，故每个用例用独立 email（随机 uuid）避免互相串扰。

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let redis: RedisService;
let loginAttempts: LoginAttemptService;
let redisAvailable = false;
let maxAttempts = 5;

async function startApp() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
  process.env.REDIS_URL ??= 'redis://localhost:6379';

  // 用 NestExpressApplication：useBodyParser 是 express 适配器上的方法（main.ts 的 bootstrap
  // 在测试里不跑，这里手动复刻 + 把 JSON 体积上限设小，好用小 payload 触发 413）。
  const a = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  a.enableShutdownHooks();
  // main.ts 的 bootstrap 在测试里不会自动跑（测试直接 NestFactory.create）。
  // 这里手动复刻一个【更小】的 JSON 体积上限（2 KB），好用一个 3 KB 的小 payload 触发 413，
  // 不必分配几百 KB。其它用例的请求体都远小于 2 KB，不受影响。
  a.useBodyParser('json', { limit: '2kb' });
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
  loginAttempts = app.get(LoginAttemptService);
  redisAvailable = await redis.ping();
  // 读配置里的锁定阈值（默认 5），用例据此决定连错几次——阈值改了用例也不破。
  maxAttempts = app
    .get(ConfigService<AppConfig, true>)
    .get('auth.lockout.maxAttempts', { infer: true });
});

after(async () => {
  await app?.close();
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
  };
}

const STRONG = 'S3cure-pass!';

async function register(email: string, password = STRONG) {
  return req('POST', '/auth/register', {
    email,
    username: email.split('@')[0],
    password,
  });
}

// ─── 账号锁定 ──────────────────────────────────────────────────────────
// 这两个用例依赖 Redis（锁定计数落在那）。Redis 没起时运行时 t.skip()——
// 注意不能用 { skip } 注册期选项：它在 import 阶段求值，那时 before() 还没跑、redisAvailable 恒 false。

test('同一账号连续失败达阈值 → 连正确密码也 423 ACCOUNT_LOCKED', async (t: TestContext) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过账号锁定用例');
  const email = `lock-${randomUUID()}@x.com`;
  await register(email);

  // 连错 maxAttempts 次：每次都 401 INVALID_CREDENTIALS（最后一次的 recordFailure 才把计数顶到阈值，
  // 但【这次】请求仍然走完密码比对、返回 401——锁定从【下一次】起生效）。
  for (let i = 0; i < maxAttempts; i++) {
    const r = await req('POST', '/auth/login', { email, password: 'definitely-wrong' });
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应为 401`);
    assert.equal(r.json.code, 'INVALID_CREDENTIALS');
  }
  assert.ok(await loginAttempts.isLocked(email), '计数达阈值，账号应处于锁定态');

  // 已锁：连【正确密码】都进不来——isLocked 在密码比对之前就把请求挡了。
  const withCorrect = await req('POST', '/auth/login', { email, password: STRONG });
  assert.equal(withCorrect.status, 423);
  assert.equal(withCorrect.json.code, 'ACCOUNT_LOCKED');

  // 锁定期间，错误密码同样是 423（不是 401），不让攻击者借响应差异探测密码对错。
  const withWrong = await req('POST', '/auth/login', { email, password: 'still-wrong' });
  assert.equal(withWrong.status, 423);
});

test('成功登录清零失败计数：之前的手滑不会被后续失败累加成锁定', async (t: TestContext) => {
  if (!redisAvailable) return t.skip('Redis 未运行，跳过账号锁定用例');
  const email = `clear-${randomUUID()}@x.com`;
  await register(email);

  // 先失败到「差一次就锁」（maxAttempts - 1）。
  for (let i = 0; i < maxAttempts - 1; i++) {
    await req('POST', '/auth/login', { email, password: 'wrong' });
  }
  assert.ok(!(await loginAttempts.isLocked(email)), '差一次未到阈值，不该锁');

  // 一次成功登录应把计数抹掉。
  const ok = await req('POST', '/auth/login', { email, password: STRONG });
  assert.equal(ok.status, 200, '正确密码应登录成功并清零计数');

  // 再失败一次：若没清零，计数会到 maxAttempts → 锁定；清零了则只是 1，账号仍可用。
  await req('POST', '/auth/login', { email, password: 'wrong' });
  const again = await req('POST', '/auth/login', { email, password: STRONG });
  assert.equal(again.status, 200, '计数被上次成功清零，再失败一次也不锁，正确密码照常登录');
});

// ─── 密码强度策略 ──────────────────────────────────────────────────────

test('注册拒绝弱密码：单字符类别 / 常见密码 → 400 VALIDATION_ERROR', async () => {
  // ① 纯小写（单一类别）：abc... 共 8 位，只命中 1 个字符类别
  const onlyLower = await register(`weak1-${randomUUID()}@x.com`, 'abcdefgh');
  assert.equal(onlyLower.status, 400);
  assert.equal(onlyLower.json.code, 'VALIDATION_ERROR');
  const pwdErr1 = onlyLower.json.errors?.find((e: { field: string }) => e.field === 'password');
  assert.ok(pwdErr1, '应给出 password 字段的强度错误');

  // ② 常见密码黑名单：即便「看起来」够复杂也拒
  const common = await register(`weak2-${randomUUID()}@x.com`, 'password123');
  assert.equal(common.status, 400);
  assert.equal(common.json.code, 'VALIDATION_ERROR');

  // ③ 强密码：大小写 + 数字 + 符号 ≥3 类、不在黑名单 → 通过
  const strong = await register(`ok-${randomUUID()}@x.com`, STRONG);
  assert.equal(strong.status, 201);
});

test('登录不卡密码强度：老规则不影响老用户的旧密码', async () => {
  // 这个保证很重要：强度策略只作用于【注册】，绝不能拿新规则卡住存量用户的登录。
  const email = `legacy-${randomUUID()}@x.com`;
  await register(email, STRONG);
  const r = await req('POST', '/auth/login', { email, password: STRONG });
  assert.equal(r.status, 200);
});

// ─── 请求体上限 ────────────────────────────────────────────────────────

test('JSON 请求体超过上限 → 413 BODY_TOO_LARGE（解析阶段就拒，不灌内存）', async () => {
  // startApp 里把上限设成 2 KB。构造一个 ~3 KB 的 body：解析阶段就被拒成 413，
  // 不会进到 controller / ValidationPipe。带不带 token 都一样（body 解析在鉴权之前）。
  const big = { email: 'x@x.com', username: 'x', password: 'y'.repeat(3 * 1024) };
  const r = await req('POST', '/auth/register', big);
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'BODY_TOO_LARGE');

  // 对照：同等结构的小 body 不超限，正常进到校验逻辑（密码太弱会被拒，但状态是 400 不是 413）。
  const small = await req('POST', '/auth/register', { email: 'y@x.com', username: 'y', password: 'y' });
  assert.notEqual(small.status, 413, '小 body 不该被体积上限拦截');
});
