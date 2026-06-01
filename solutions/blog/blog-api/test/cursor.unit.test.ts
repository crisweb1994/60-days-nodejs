import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { encodeCursor, decodeCursor } from '../src/posts/cursor';

// 纯函数，无依赖、无 DB —— 游标编解码的契约测试

test('cursor：编码再解码 → 原样还原 payload', () => {
  const payload = { v: '2026-01-01T00:00:00.000Z', id: 'abc-123' };
  assert.deepEqual(decodeCursor(encodeCursor(payload)), payload);
});

test('cursor：token 是 URL 安全的 base64url（无 + / =）', () => {
  const token = encodeCursor({ v: 'a b/c+d=e 中文', id: 'x'.repeat(40) });
  assert.ok(/^[A-Za-z0-9_-]+$/.test(token), `token 含非 base64url 字符: ${token}`);
});

test('cursor：畸形输入解码返回 null，不抛异常', () => {
  assert.equal(decodeCursor('!!!not-valid!!!'), null);
  assert.equal(decodeCursor(''), null);
  // 合法 base64url 但不是合法 JSON
  assert.equal(decodeCursor(Buffer.from('not json', 'utf8').toString('base64url')), null);
  // 合法 JSON 但结构不对（v 不是 string）→ 也要拒
  assert.equal(decodeCursor(Buffer.from('{"v":1,"id":"a"}', 'utf8').toString('base64url')), null);
  // 缺 id
  assert.equal(decodeCursor(Buffer.from('{"v":"x"}', 'utf8').toString('base64url')), null);
});
