import 'reflect-metadata';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'node:net';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE_SERVICE } from '../src/storage/storage.constants';
import type { StorageService } from '../src/storage/storage.service';

// ============================================================================
// Day 39 测试：文件上传与存储 —— multipart 上传、sharp 核验、本地后端落盘、
// 超限 / 非图片 / 鉴权 各类拒绝、以及旧封面清理。
// 起完整 Nest 应用 + 真 PG + 本地存储后端（默认）。S3 不在本环境跑（需要真实对象存储）。
// ============================================================================

// 一张 1×1 的合法 PNG（base64）。用它做「正常图片」fixture——sharp 能解析出 width/height。
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let app: INestApplication;
let baseUrl: string;
let prisma: PrismaService;
let storage: StorageService;

let authorToken = '';
let otherToken = '';
let adminToken = '';
let authorId = '';
const asAuthor = () => ({ authorization: `Bearer ${authorToken}` });
const asOther = () => ({ authorization: `Bearer ${otherToken}` });

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
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

// multipart 上传助手：用浏览器同款 FormData（Node 内建），fetch 自动带 multipart 边界。
async function uploadCover(
  postId: string,
  buffer: Buffer,
  contentType: string,
  filename: string,
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  // new Uint8Array(buffer) 拷一份、保证底层是 ArrayBuffer（Buffer 在新版 @types/node 是
  // Buffer<ArrayBufferLike>，直接当 BlobPart 会因 SharedArrayBuffer 分支被 TS 拒绝）。
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  const res = await fetch(`${baseUrl}/posts/${postId}/cover`, {
    method: 'POST',
    headers, // ★ 不要手设 Content-Type：fetch 会带上正确的 multipart boundary
    body: form,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const validPost = (over: Record<string, unknown> = {}) => ({
  title: 'Cover Story',
  slug: 'cover-story',
  content: 'a long enough content body for validation',
  status: 'draft',
  ...over,
});

async function createPostAsAuthor(slug: string): Promise<string> {
  const r = await req('POST', '/posts', validPost({ slug }), asAuthor());
  assert.equal(r.status, 201);
  return r.json.data.id as string;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.DATABASE_URL ??=
    'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
  // UPLOAD_MAX_BYTES 在 setup.cjs 预加载阶段就设成 1 KiB（详见 setup.cjs 注释）：
  // @nestjs/config 在【import 阶段】就烘焙配置，before() 里设 env 太晚、读不到。
  // 这里只在 before 里留个注释提醒；真正的值见 setup.cjs。

  app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
  storage = app.get<StorageService>(STORAGE_SERVICE);

  await prisma.post.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const author = await req('POST', '/auth/register', {
    email: 'author@e2e.test',
    username: 'author',
    password: 'Pass-1234',
  });
  authorToken = author.json.data.accessToken;
  authorId = author.json.data.user.id;

  otherToken = (
    await req('POST', '/auth/register', {
      email: 'other@e2e.test',
      username: 'other',
      password: 'Pass-1234',
    })
  ).json.data.accessToken;

  const admin = await req('POST', '/auth/register', {
    email: 'admin@e2e.test',
    username: 'adminuser',
    password: 'Pass-1234',
  });
  await prisma.user.update({
    where: { id: admin.json.data.user.id },
    data: { role: 'admin' },
  });
  adminToken = (
    await req('POST', '/auth/login', {
      email: 'admin@e2e.test',
      password: 'Pass-1234',
    })
  ).json.data.accessToken;
});

after(async () => {
  await app?.close();
});

beforeEach(async () => {
  await prisma.post.deleteMany();
});

// ─── 1) 正常上传：合法 PNG → 200 + meta.coverImage 落地 + 文件真实存在 ──────────

test('1) 上传合法 PNG → 200，meta.coverImage 写入并真实落盘', async () => {
  const id = await createPostAsAuthor('cover-ok');
  const r = await uploadCover(id, PNG_1x1, 'image/png', 'cover.png', asAuthor());

  assert.equal(r.status, HttpStatus.OK, JSON.stringify(r.json));
  assert.equal(r.json.code, 0);
  const url = r.json.data.meta?.coverImage;
  assert.ok(url, '应写入 meta.coverImage');
  assert.match(url, /^\/uploads\/covers\//, '本地后端 URL 应以 /uploads/ 开头');

  // 文件确实落盘了（key 由 URL 反推）。
  const key = storage.keyFromPublicUrl(url);
  assert.ok(key);
  assert.equal(await storage.exists(key), true, '文件应真实存在');

  // URL 不含用户上传的文件名（key 是服务端 uuid 生成）——防信息泄露 / 路径穿越。
  assert.ok(!url.includes('cover.png'), 'URL 不应回显原始文件名');
});

// ─── 2) 超限：超过 UPLOAD_MAX_BYTES → 413 UPLOAD_TOO_LARGE ──────────────────

test('2) 超过大小上限 → 413 UPLOAD_TOO_LARGE', async () => {
  const id = await createPostAsAuthor('cover-big');
  const oversized = Buffer.alloc(2048, 0x41); // 2 KiB，超过测试用的 1 KiB 上限
  const r = await uploadCover(id, oversized, 'image/png', 'big.png', asAuthor());

  assert.equal(r.status, HttpStatus.PAYLOAD_TOO_LARGE);
  assert.equal(r.json.code, 'UPLOAD_TOO_LARGE');
});

// ─── 3) 非图片 MIME：fileFilter 早拦截 → 415 UNSUPPORTED_MEDIA_TYPE ──────────

test('3) 非图片 MIME → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
  const id = await createPostAsAuthor('cover-pdf');
  const r = await uploadCover(id, PNG_1x1, 'application/pdf', 'doc.pdf', asAuthor());

  assert.equal(r.status, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  assert.equal(r.json.code, 'UNSUPPORTED_MEDIA_TYPE');
});

// ─── 4) 伪装图片：MIME 是 png 但字节不是图 → sharp 核验失败 → 422 INVALID_FILE ─

test('4) 伪装成 png 的非图字节 → sharp 核验失败 422', async () => {
  const id = await createPostAsAuthor('cover-fake');
  const fake = Buffer.from('这不是一张图片，只是一段文本');
  const r = await uploadCover(id, fake, 'image/png', 'trick.png', asAuthor());

  assert.equal(r.status, HttpStatus.UNPROCESSABLE_ENTITY);
  assert.equal(r.json.code, 'INVALID_FILE');
});

// ─── 5) 鉴权：未登录 401；非作者 403 ───────────────────────────────────────

test('5) 未登录上传 → 401；非作者上传 → 403', async () => {
  const id = await createPostAsAuthor('cover-auth');

  const noAuth = await uploadCover(id, PNG_1x1, 'image/png', 'c.png');
  assert.equal(noAuth.status, HttpStatus.UNAUTHORIZED);

  const notOwner = await uploadCover(id, PNG_1x1, 'image/png', 'c.png', asOther());
  assert.equal(notOwner.status, HttpStatus.FORBIDDEN);
});

// ─── 6) admin 可改任意文章封面（资源级权限复用）──────────────────────────────

test('6) admin 可上传他人文章封面 → 200', async () => {
  const id = await createPostAsAuthor('cover-admin');
  const r = await uploadCover(id, PNG_1x1, 'image/png', 'c.png', {
    authorization: `Bearer ${adminToken}`,
  });
  assert.equal(r.status, HttpStatus.OK);
  assert.ok(r.json.data.meta?.coverImage);
});

// ─── 7) 旧封面清理：再次上传后，旧文件应被删（孤儿清理）──────────────────────

test('7) 重复上传 → 旧封面被清理（无孤儿对象）', async () => {
  const id = await createPostAsAuthor('cover-replace');
  const first = await uploadCover(id, PNG_1x1, 'image/png', 'a.png', asAuthor());
  const oldKey = storage.keyFromPublicUrl(first.json.data.meta.coverImage);
  assert.ok(oldKey, '应能从旧 URL 反推 key');
  assert.equal(await storage.exists(oldKey), true);

  const second = await uploadCover(id, PNG_1x1, 'image/png', 'b.png', asAuthor());
  const newKey = storage.keyFromPublicUrl(second.json.data.meta.coverImage);
  assert.ok(newKey, '应能从新 URL 反推 key');

  // 新文件在；旧文件被 best-effort 清理（异步，轮询一下）。
  assert.equal(await storage.exists(newKey), true);
  let oldGone = false;
  for (let i = 0; i < 40; i++) {
    if (!(await storage.exists(oldKey))) {
      oldGone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(oldGone, '旧封面应被清理');
});

// ─── 8) 不存在的文章 → 404（优先于 403）──────────────────────────────────────

test('8) 不存在的文章上传 → 404 POST_NOT_FOUND', async () => {
  const r = await uploadCover(
    '00000000-0000-4000-8000-000000000000',
    PNG_1x1,
    'image/png',
    'c.png',
    asAuthor(),
  );
  assert.equal(r.status, HttpStatus.NOT_FOUND);
  assert.equal(r.json.code, 'POST_NOT_FOUND');
});
