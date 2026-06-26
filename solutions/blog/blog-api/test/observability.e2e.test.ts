import 'reflect-metadata';
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';

// Day 45 端到端：验证「错误上报 + 链路关联」在真实 HTTP 链路里的可观测契约。
// 用 GET /posts/debug/boom（故意抛原始 Error → 500）当探针：
//   - 响应必须是 500 + 固定安全文案（绝不泄露 triggerBoom 抛的 message）；
//   - 请求带的 x-request-id 必须原样回显（Filter / Interceptor / Logger 全链路靠它串联）。
// （Sentry 上报的「确实调过 capture」在 observability.unit.test.ts 里用假 reporter 断言——
//   这里没配真 DSN，capture 是 no-op，故只验可观测的 HTTP 契约。）

let app: INestApplication;
let baseUrl: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  const a = await NestFactory.create(AppModule, { logger: false });
  a.enableShutdownHooks();
  await a.listen(0);
  app = a;
  baseUrl = `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await app?.close();
});

async function req(method: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  let data: any = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应兜底 */
  }
  return { status: res.status, data };
}

test('/posts/debug/boom：500 + 安全文案 + requestId 回显', async () => {
  const r = await req('GET', '/posts/debug/boom', { 'x-request-id': 'boom-req-1' });
  assert.equal(r.status, 500);
  assert.equal(r.data.code, 500);
  // 固定安全文案：客户端永远看不到 triggerBoom 抛出的「boom! ...」
  assert.equal(r.data.message, '服务器内部错误');
  assert.equal(String(r.data.message).includes('boom'), false);
  // requestId 原样回显——这是日志/监控/Sentry 事件互相串起来的钥匙
  assert.equal(r.data.requestId, 'boom-req-1');
});
