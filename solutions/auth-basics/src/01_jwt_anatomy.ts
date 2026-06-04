// Day 31 demo①：把一个 JWT 拆开看 —— 三段是什么、为什么能防篡改、为什么不能放秘密
import { decode, sign, verify } from './jwt.js';

const line = (t = '') => console.log(t);
const section = (t: string) => {
  line('\n' + '═'.repeat(64));
  line('  ' + t);
  line('═'.repeat(64));
};

const SECRET = 'dev-secret-change-me-in-prod';

section('1. 签发一个 JWT');
const token = sign({ sub: 'user-123', role: 'admin' }, SECRET, { expiresInSec: 3600 });
line(token);
line(`\n它就是三段用 "." 拼起来的：`);
const [h, p, s] = token.split('.');
line(`  header    (${h.length}) = ${h}`);
line(`  payload   (${p.length}) = ${p}`);
line(`  signature (${s.length}) = ${s}`);

section('2. header / payload 只是 base64url，谁都能解开读');
const parts = decode(token)!;
line('header  = ' + JSON.stringify(parts.header));
line('payload = ' + JSON.stringify(parts.payload));
line('\n⚠️  payload 没有加密，只是编码。结论：别往里放密码 / 密钥 / 任何敏感数据。');
line('   它能被信任，不是因为「读不到」，而是因为「改不动」——看下一步。');

section('3. 验签：对的 secret 通过，错的 secret 失败');
line('verify(token, 正确 secret) → ' + JSON.stringify(verify(token, SECRET)));
line('verify(token, 错误 secret) → ' + JSON.stringify(verify(token, 'attacker-guess')));

section('4. 篡改 payload（不重新签名）→ 验签失败');
// 攻击者把 role 改成 superadmin，但他没有 secret，签不出新签名，只能沿用旧签名
const tampered = (() => {
  const payloadObj = decode(token)!.payload as Record<string, unknown>;
  payloadObj.role = 'superadmin';
  const forgedPayload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  return `${h}.${forgedPayload}.${s}`; // 旧签名配新 payload
})();
line('被篡改的 token 解码后 role = ' + JSON.stringify((decode(tampered)!.payload as any).role));
line('verify(tampered) → ' + JSON.stringify(verify(tampered, SECRET)));
line('\n签名是对 header+payload 算的；payload 一改，重算的签名就对不上 → bad-signature。');
line('这就是为什么「能读但不能改」：防篡改靠的是签名，不是保密。');

section('5. 过期：exp 到点后自动失效（无状态，服务端不查库）');
const expired = sign({ sub: 'user-123' }, SECRET, { expiresInSec: -10 }); // 10 秒前就过期
line('verify(expired) → ' + JSON.stringify(verify(expired, SECRET)));
line('\n服务端只看 token 自带的 exp 判断过期——这正是「无状态」的含义：不依赖服务端会话记录。');
