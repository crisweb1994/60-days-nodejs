import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePostDto } from '../src/posts/dto/create-post.dto';
import { UpdatePostDto } from '../src/posts/dto/update-post.dto';

function build<T extends object>(cls: new () => T, payload: unknown) {
  return plainToInstance(cls, payload);
}

test('CreatePostDto: 合法数据通过', async () => {
  const dto = build(CreatePostDto, {
    title: 'Hello',
    slug: 'hello-world',
    content: 'a'.repeat(20),
    status: 'draft',
    tags: ['x'],
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});

test('CreatePostDto: 缺字段会被报告', async () => {
  const dto = build(CreatePostDto, { title: 'x' });
  const errors = await validate(dto);
  const fields = errors.map((e) => e.property).sort();
  assert.deepEqual(fields, ['content', 'slug', 'status']);
});

test('CreatePostDto: slug 非法时 IsSlug 触发', async () => {
  const dto = build(CreatePostDto, {
    title: 'x',
    slug: 'Bad_Slug!',
    content: 'a'.repeat(20),
    status: 'draft',
  });
  const errors = await validate(dto);
  const slugErr = errors.find((e) => e.property === 'slug');
  assert.ok(slugErr, '应该报告 slug 错误');
  assert.ok(slugErr.constraints?.IsSlug);
});

test('CreatePostDto: 嵌套 meta 字段也被递归校验', async () => {
  const dto = build(CreatePostDto, {
    title: 'x',
    slug: 'ok',
    content: 'a'.repeat(20),
    status: 'draft',
    meta: { seoTitle: '', seoDescription: '' },
  });
  const errors = await validate(dto);
  const metaErr = errors.find((e) => e.property === 'meta');
  assert.ok(metaErr, '应该有 meta 错误');
  assert.ok(metaErr.children && metaErr.children.length > 0, '应有 children');
});

test('UpdatePostDto: 全字段可选，空对象合法', async () => {
  const dto = build(UpdatePostDto, {});
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});

test('UpdatePostDto: 出现字段时仍走原校验规则', async () => {
  const dto = build(UpdatePostDto, { slug: 'BAD!' });
  const errors = await validate(dto);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].property, 'slug');
});
