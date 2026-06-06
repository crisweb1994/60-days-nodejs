import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { AuthService } from '../src/auth/auth.service';
import { OAuthStateStore } from '../src/auth/oauth/oauth-state.store';
import type { GithubUser } from '../src/auth/oauth/github-oauth.provider';

// ─── OAuthStateStore（防 CSRF / 重放）─────────────────────────────────

test('OAuthStateStore：generate 产生唯一 hex，consume 一次性消费', () => {
  const store = new OAuthStateStore();
  const a = store.generate();
  const b = store.generate();
  assert.notEqual(a, b, '两次 generate 不应相同');
  assert.match(a, /^[0-9a-f]{32}$/, '应是 16 字节 hex');

  assert.equal(store.consume(a), true, '第一次消费有效');
  assert.equal(store.consume(a), false, '用过即失效（防重复回调 / 重放）');
  assert.equal(store.consume('never-generated'), false, '未知 state 一律拒绝（防 CSRF）');
});

// ─── AuthService.loginWithGithub（三步绑定）──────────────────────────
// 不连库：用假 prisma 路由 findUnique（按 where 里的键判断查的是哪一列）。

function makeService(seed: {
  byGithubId?: any;
  byEmail?: any;
  takenUsernames?: Set<string>;
}) {
  const calls: { created: any; updated: any; issuedFor: string | null } = {
    created: null,
    updated: null,
    issuedFor: null,
  };
  const taken = seed.takenUsernames ?? new Set<string>();
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => {
        if ('githubId' in where) return seed.byGithubId ?? null;
        if ('email' in where) return seed.byEmail ?? null;
        if ('username' in where) return taken.has(where.username) ? { id: 'x' } : null;
        return null;
      },
      update: async ({ where, data }: any) => {
        calls.updated = { where, data };
        return { ...(seed.byEmail ?? {}), ...data, id: where.id };
      },
      create: async ({ data }: any) => {
        calls.created = data;
        return { id: 'new-id', role: 'user', createdAt: new Date(), ...data };
      },
    },
  };
  const tokens: any = {
    issue: async (u: any) => {
      calls.issuedFor = u.id;
      return { accessToken: 'a', refreshToken: 'r', expiresIn: 900 };
    },
  };
  return { svc: new AuthService(prisma, tokens), calls };
}

const gh: GithubUser = { id: '12345', login: 'octocat', name: 'Octo', email: 'octo@example.com' };

test('loginWithGithub：已绑定 githubId → 直接登录，不建号也不更新', async () => {
  const user = {
    id: 'u-existing',
    email: 'e@x.com',
    username: 'octocat',
    role: 'user',
    createdAt: new Date(),
  };
  const { svc, calls } = makeService({ byGithubId: user });
  const res = await svc.loginWithGithub(gh);
  assert.equal(res.user.id, 'u-existing');
  assert.equal(calls.created, null, '不应建号');
  assert.equal(calls.updated, null, '不应更新');
  assert.equal(calls.issuedFor, 'u-existing', '给已有用户发 token');
});

test('loginWithGithub：邮箱已注册但未绑定 → 关联（写入 githubId）', async () => {
  const existing = {
    id: 'u-by-email',
    email: 'octo@example.com',
    username: 'someone',
    role: 'user',
    createdAt: new Date(),
  };
  const { svc, calls } = makeService({ byEmail: existing });
  const res = await svc.loginWithGithub(gh);
  assert.equal(calls.updated.where.id, 'u-by-email');
  assert.equal(calls.updated.data.githubId, '12345', '把 GitHub id 绑到老账号上');
  assert.equal(calls.created, null, '不该重复建号');
  assert.equal(res.user.id, 'u-by-email');
});

test('loginWithGithub：全新用户 → 建号（password=null + 派生 username）', async () => {
  const { svc, calls } = makeService({});
  const res = await svc.loginWithGithub(gh);
  assert.equal(calls.created.githubId, '12345');
  assert.equal(calls.created.password, null, '第三方登录无密码');
  assert.equal(calls.created.email, 'octo@example.com');
  assert.equal(calls.created.username, 'octocat');
  assert.equal(res.user.email, 'octo@example.com');
  // ★ 出口脱敏：响应里绝不能带 password
  assert.equal('password' in (res.user as any), false);
});

test('loginWithGithub：GitHub 无公开邮箱 → 用 noreply 占位邮箱', async () => {
  const { svc, calls } = makeService({});
  await svc.loginWithGithub({ id: '999', login: 'ghost', name: null, email: null });
  assert.equal(calls.created.email, '999+ghost@users.noreply.github.com');
});

test('loginWithGithub：username 撞车 → 自动补随机后缀', async () => {
  const { svc, calls } = makeService({ takenUsernames: new Set(['octocat']) });
  await svc.loginWithGithub(gh);
  assert.notEqual(calls.created.username, 'octocat');
  assert.match(calls.created.username, /^octocat-[0-9a-f]{4}$/);
});
