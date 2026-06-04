// ============================================================================
// 手写一个最小 JWT（HS256）—— 只用 node:crypto，不依赖任何库
// ----------------------------------------------------------------------------
// 目的不是造轮子（生产请用 @nestjs/jwt / jsonwebtoken），而是把 "Token 结构" 看穿：
// 一个 JWT 就是  base64url(header) . base64url(payload) . base64url(HMAC签名)
// 三段拿点号拼起来。看完这个文件，jwt.io 上那串东西就没有秘密了。
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

// payload 里 iat/exp 是「注册声明（registered claims）」，其余是你自定义的
export type JwtPayload = Record<string, unknown> & {
  iat?: number; // issued at（秒级时间戳）
  exp?: number; // expires at（秒级时间戳）
};

export type VerifyResult =
  | { valid: true; payload: JwtPayload }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'expired' };

// base64url：和普通 base64 的区别是 +/= 换成 -_ 并去掉填充，URL 安全
const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64url');

const fromB64url = (input: string): Buffer => Buffer.from(input, 'base64url');

// 签名 = 对 "header.payload" 做 HMAC-SHA256，再 base64url
function signingSignature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

// 现在的秒级时间戳
const nowSec = (): number => Math.floor(Date.now() / 1000);

/** 签发一个 JWT */
export function sign(
  payload: JwtPayload,
  secret: string,
  opts: { expiresInSec?: number } = {},
): string {
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const iat = nowSec();
  const fullPayload: JwtPayload = { iat, ...payload };
  if (opts.expiresInSec !== undefined) fullPayload.exp = iat + opts.expiresInSec;

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(fullPayload))}`;
  return `${signingInput}.${signingSignature(signingInput, secret)}`;
}

/** 校验签名 + 过期。任何一步不过都不算有效——这是「无状态」认证的全部信任来源 */
export function verify(token: string, secret: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [headerB64, payloadB64, signatureB64] = parts;

  // 1) 验签：用同一个 secret 重算签名，和 token 里带的比。不一致 = 被篡改/伪造。
  //    用 timingSafeEqual 做常量时间比较，避免按字符逐位比较泄露时序信息。
  const expected = signingSignature(`${headerB64}.${payloadB64}`, secret);
  const given = Buffer.from(signatureB64);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { valid: false, reason: 'bad-signature' };
  }

  // 2) 解析 payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // 3) 验过期（注意：这是「自验证」——服务端不查库，全靠 token 自己带的 exp）
  if (typeof payload.exp === 'number' && nowSec() >= payload.exp) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}

/**
 * 只解码、不验签。⚠️ 这恰恰说明：**JWT 不是加密**，payload 任何人都能 base64 解开读到。
 * 所以别往 payload 里塞密码、密钥等敏感信息。
 */
export function decode(
  token: string,
): { header: unknown; payload: unknown } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(fromB64url(parts[0]).toString('utf8')),
      payload: JSON.parse(fromB64url(parts[1]).toString('utf8')),
    };
  } catch {
    return null;
  }
}
