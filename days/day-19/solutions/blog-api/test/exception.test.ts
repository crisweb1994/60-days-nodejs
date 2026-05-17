import 'reflect-metadata';
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BadRequestException,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { AddressInfo } from 'node:net';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware';
import { PostsModule } from '../src/posts/posts.module';

// 复制 AppModule（避免 require 主入口时启动 main.ts）
@Module({
  imports: [PostsModule],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
class TestAppModule implements NestModule {
  configure(c: MiddlewareConsumer) {
    c.apply(RequestIdMiddleware).forRoutes('*');
  }
}

let app: INestApplication;
let baseUrl: string;

before(async () => {
  app = await NestFactory.create(TestAppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          code: 'VALIDATION_ERROR',
          errors: errors.map((e) => ({
            field: e.property,
            messages: Object.values(e.constraints ?? {}),
          })),
        }),
    }),
  );
  await app.listen(0);
  const server = app.getHttpServer();
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

test('成功响应：统一外壳 { code: 0, data, message: "ok" }', async () => {
  const r = await req('GET', '/posts');
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.message, 'ok');
  assert.ok(r.json.data);
  assert.ok(r.json.requestId);
  assert.equal(r.headers.get('x-request-id'), r.json.requestId);
});

test('未知异常：500 + 通用文案，不泄漏 error.message', async () => {
  const r = await req('GET', '/posts/debug/boom');
  assert.equal(r.status, 500);
  assert.equal(r.json.code, 500);
  assert.equal(r.json.message, '服务器内部错误');
  assert.equal(r.json.data, null);
  // boom 里的真实 message 不能出现在响应里
  assert.ok(!JSON.stringify(r.json).includes('boom!'));
});

test('NotFoundException：透传 message + 数字 code = HTTP status', async () => {
  const r = await req('GET', '/posts/9999');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 404);
  assert.match(r.json.message, /not found/i);
});

test('BusinessException：走控制器级 filter，category=business，code 是字符串', async () => {
  await req('POST', '/posts', {
    title: 'dup',
    slug: 'duplicate-slug',
    content: 'long enough content',
    status: 'draft',
  });
  const r = await req('POST', '/posts', {
    title: 'dup2',
    slug: 'duplicate-slug',
    content: 'long enough content',
    status: 'draft',
  });
  assert.equal(r.status, HttpStatus.CONFLICT);
  assert.equal(r.json.code, 'SLUG_TAKEN');
  assert.equal(r.json.category, 'business');
});

test('校验失败：BadRequest + errors 字段透传到响应外壳', async () => {
  const r = await req('POST', '/posts', { title: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(r.json.errors));
  assert.ok(r.json.errors.length > 0);
});

test('archived 文章拒绝更新 → POST_ARCHIVED', async () => {
  const create = await req('POST', '/posts', {
    title: 'arch',
    slug: 'archived-one',
    content: 'long enough content',
    status: 'archived',
  });
  const id = create.json.data.id;
  const r = await req('PATCH', `/posts/${id}`, { title: 'new title' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'POST_ARCHIVED');
  assert.equal(r.json.category, 'business');
});

test('上游传 x-request-id 时被尊重', async () => {
  const res = await fetch(`${baseUrl}/posts`, {
    headers: { 'x-request-id': 'trace-abc-123' },
  });
  const json = await res.json();
  assert.equal(json.requestId, 'trace-abc-123');
  assert.equal(res.headers.get('x-request-id'), 'trace-abc-123');
});
