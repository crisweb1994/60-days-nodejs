// Day 31 demo②：有状态（Session）vs 无状态（JWT）——核心差异在「登出/撤销」
import { randomUUID } from 'node:crypto';
import { sign, verify, type JwtPayload } from './jwt.js';

const line = (t = '') => console.log(t);
const section = (t: string) => {
  line('\n' + '═'.repeat(64));
  line('  ' + t);
  line('═'.repeat(64));
};
const SECRET = 'dev-secret-change-me-in-prod';

// ─── 有状态：服务端存会话，cookie 只存一个不透明的 sessionId ───────────────
class SessionStore {
  // 真实项目里这张表在 Redis（Day 36），这里用 Map 演示
  private readonly store = new Map<string, { userId: string; createdAt: number }>();

  login(userId: string): string {
    const sessionId = randomUUID(); // 不透明随机串，本身不含任何信息
    this.store.set(sessionId, { userId, createdAt: Date.now() });
    return sessionId;
  }
  validate(sessionId: string): string | null {
    return this.store.get(sessionId)?.userId ?? null; // 每次请求都查这张表
  }
  logout(sessionId: string): void {
    this.store.delete(sessionId); // 删掉即刻失效 ← 关键
  }
  get size(): number {
    return this.store.size;
  }
}

section('A. 有状态 Session：登出 = 服务端删记录，立即失效');
const sessions = new SessionStore();
const sid = sessions.login('user-123');
line(`登录 → sessionId = ${sid}（注意：它不含 userId，是个不透明随机串）`);
line(`validate(sid) → ${sessions.validate(sid)}   服务端表里有 ${sessions.size} 条会话`);
sessions.logout(sid);
line(`登出后 validate(sid) → ${sessions.validate(sid)}   服务端表里有 ${sessions.size} 条会话`);
line('\n✅ 撤销是「立即」的：删了记录，这个 session 当场作废。代价是服务端要存、要查（有状态）。');

// ─── 无状态：服务端不存会话，信任全靠 token 自带的签名 ───────────────
section('B. 无状态 JWT：服务端不存东西，「登出」却没法让已签发的 token 立刻失效');
const jwt = sign({ sub: 'user-456', role: 'user' }, SECRET, { expiresInSec: 3600 });
line(`登录 → 拿到 JWT（自带 userId/role，服务端不记任何东西）`);
line(`validate(jwt) → ${JSON.stringify(verify(jwt, SECRET).valid)}`);
line(`\n用户点「登出」：服务端能做什么？什么也做不了——它没存这个 token。`);
line(`登出后 validate(jwt) → ${JSON.stringify(verify(jwt, SECRET).valid)}  ← 仍然有效！`);
line('\n⚠️ 这就是无状态的代价：token 在 exp 到点前一直有效，服务端无法主动作废它。');

// ─── 折中：给 JWT 加一个 jti + 服务端黑名单（但这就把「状态」加回来了）───
section('C. 想让 JWT 能撤销？加 jti + 黑名单——本质是把状态加回来');
const blocklist = new Set<string>(); // 真实项目放 Redis，带 TTL 到 token 的 exp
function issue(userId: string): string {
  return sign({ sub: userId, jti: randomUUID() }, SECRET, { expiresInSec: 3600 });
}
function validateWithBlocklist(token: string): boolean {
  const res = verify(token, SECRET);
  if (!res.valid) return false;
  const jti = (res.payload as JwtPayload).jti as string | undefined;
  return jti !== undefined && !blocklist.has(jti); // 命中黑名单就拒
}
const jwt2 = issue('user-789');
const jti = (verify(jwt2, SECRET) as any).payload.jti;
line(`validateWithBlocklist(jwt2) → ${validateWithBlocklist(jwt2)}`);
blocklist.add(jti); // 登出：把这个 jti 拉黑
line(`把 jti 拉黑（登出）后 → ${validateWithBlocklist(jwt2)}`);
line('\n能撤销了——但代价是每次请求都要查黑名单（Redis），又变回「有状态」。');
line('天下没有免费的午餐：纯无状态省了存储/查询，但换不来「即时撤销」。');

section('小结：怎么选');
line('• 单体 / 传统 Web、需要即时登出、服务器端渲染   → Session（配 Redis 存储）');
line('• 多服务 / 移动端 / 第三方 API、要免共享会话存储 → JWT（短期 access + refresh，见 Day 32）');
line('• 现实里常常混用：JWT 做无状态 access，refresh token 落库可撤销。');
