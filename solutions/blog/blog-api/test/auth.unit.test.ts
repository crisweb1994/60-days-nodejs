import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { BusinessException } from '../src/common/exceptions/business.exception';

// 不连库、不起 Nest：直接 new JwtService + new 守卫，验证安全关键逻辑

const SECRET = 'unit-test-secret-at-least-16-chars';
const jwt = new JwtService({ secret: SECRET });
const guard = new JwtAuthGuard(jwt);

// 造一个最小 ExecutionContext，只暴露 switchToHttp().getRequest()
function ctx(headers: Record<string, string>, sink?: { req?: any }): ExecutionContext {
  const req: any = { headers };
  if (sink) sink.req = req;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const isUnauthorized = (e: unknown) =>
  e instanceof BusinessException && e.bizCode === 'UNAUTHORIZED';

// ─── bcrypt ──────────────────────────────────────────────────────────

test('bcrypt：hash 后 compare 正确密码 true / 错误 false', async () => {
  const hash = await bcrypt.hash('S3cure-pass', 10);
  assert.ok(hash.startsWith('$2'), '应是 bcrypt 哈希');
  assert.notEqual(hash, 'S3cure-pass', '绝不能等于明文');
  assert.equal(await bcrypt.compare('S3cure-pass', hash), true);
  assert.equal(await bcrypt.compare('wrong-pass', hash), false);
});

// ─── JwtAuthGuard ────────────────────────────────────────────────────

test('JwtAuthGuard：有效 Bearer token → 放行并挂上 req.user', async () => {
  const token = await jwt.signAsync({ sub: 'u1', role: 'user' });
  const sink: { req?: any } = {};
  const ok = await guard.canActivate(ctx({ authorization: `Bearer ${token}` }, sink));
  assert.equal(ok, true);
  assert.equal(sink.req.user.sub, 'u1');
  assert.equal(sink.req.user.role, 'user');
});

test('JwtAuthGuard：缺少 Authorization → UNAUTHORIZED', async () => {
  await assert.rejects(() => guard.canActivate(ctx({})), isUnauthorized);
});

test('JwtAuthGuard：非 Bearer / 乱 token → UNAUTHORIZED', async () => {
  await assert.rejects(
    () => guard.canActivate(ctx({ authorization: 'Basic abc' })),
    isUnauthorized,
  );
  await assert.rejects(
    () => guard.canActivate(ctx({ authorization: 'Bearer not-a-jwt' })),
    isUnauthorized,
  );
});

test('JwtAuthGuard：用别的 secret 签的 token → UNAUTHORIZED（验签失败）', async () => {
  const evil = new JwtService({ secret: 'a-totally-different-secret-key!!' });
  const token = await evil.signAsync({ sub: 'u1', role: 'admin' });
  await assert.rejects(
    () => guard.canActivate(ctx({ authorization: `Bearer ${token}` })),
    isUnauthorized,
  );
});

test('JwtAuthGuard：已过期 token → UNAUTHORIZED', async () => {
  const token = await jwt.signAsync({ sub: 'u1', role: 'user' }, { expiresIn: -10 });
  await assert.rejects(
    () => guard.canActivate(ctx({ authorization: `Bearer ${token}` })),
    isUnauthorized,
  );
});

// ─── RolesGuard（Day 33）─────────────────────────────────────────────

// stub Reflector：直接返回该路由"要求的角色"
function rolesGuard(required: string[] | undefined): RolesGuard {
  return new RolesGuard({
    getAllAndOverride: () => required,
  } as unknown as Reflector);
}
function rolesCtx(role?: string): ExecutionContext {
  const req = { user: role ? { sub: 'u', role } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}
const isForbidden = (e: unknown) =>
  e instanceof BusinessException && e.bizCode === 'FORBIDDEN';

test('RolesGuard：路由没声明 @Roles → 放行（不限角色）', () => {
  assert.equal(rolesGuard(undefined).canActivate(rolesCtx('user')), true);
  assert.equal(rolesGuard([]).canActivate(rolesCtx('user')), true);
});

test('RolesGuard：要求 admin，用户是 admin → 放行', () => {
  assert.equal(rolesGuard(['admin']).canActivate(rolesCtx('admin')), true);
});

test('RolesGuard：要求 admin，用户是 user → FORBIDDEN', () => {
  assert.throws(() => rolesGuard(['admin']).canActivate(rolesCtx('user')), isForbidden);
});

test('RolesGuard：要求 admin 但没有 user（守卫顺序错）→ UNAUTHORIZED', () => {
  assert.throws(
    () => rolesGuard(['admin']).canActivate(rolesCtx(undefined)),
    isUnauthorized,
  );
});
