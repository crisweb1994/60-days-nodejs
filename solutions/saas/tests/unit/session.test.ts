import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  readSessionToken,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  verifySessionToken,
} from "@/server/auth/session";

// 与 tests/unit/setup-env.ts 中的固定密钥保持一致，
// 用于构造“签名合法但内容异常”的令牌，覆盖签名校验之后的分支。
const UNIT_SESSION_SECRET = "unit-test-session-secret-32-bytes!!";

function signBody(body: string): string {
  return createHmac("sha256", UNIT_SESSION_SECRET)
    .update(body)
    .digest("base64url");
}

function forgeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signBody(body)}`;
}

// 会话令牌是无状态认证的全部信任基础：签名可验证、过期可拒绝、
// Cookie 属性正确，这三件事任何一件坏了都不只是功能问题。
describe("session token", () => {
  it("签发的令牌可以验证，并返回签发时的 userId", () => {
    const token = createSessionToken("user-123");

    const payload = verifySessionToken(token);
    expect(payload?.userId).toBe("user-123");
    expect(payload?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("同一 userId 两次签发的令牌不同（nonce）", () => {
    expect(createSessionToken("user-123")).not.toBe(
      createSessionToken("user-123"),
    );
  });

  it("篡改 payload 或签名都会验证失败", () => {
    const token = createSessionToken("user-123");
    const [, signature] = token.split(".");

    // 攻击者没有密钥：换掉 payload 只能保留旧签名，签名对不上新 body。
    const swappedBody = Buffer.from(
      JSON.stringify({
        userId: "attacker",
        expiresAt: Date.now() + 1e9,
        nonce: "n",
      }),
    ).toString("base64url");
    expect(verifySessionToken(`${swappedBody}.${signature}`)).toBeNull();

    // forgeToken 签出的令牌是“合法”的——它证明测试拿得到密钥，
    // 真正的边界在密钥不泄漏：换一个错误签名（长度对齐避免提前 short-circuit）。
    const forged = forgeToken({
      userId: "user-123",
      expiresAt: Date.now() + 1e9,
      nonce: "n",
    });
    const [forgedBody] = forged.split(".");
    expect(
      verifySessionToken(`${forgedBody}.${"a".repeat(signature.length)}`),
    ).toBeNull();

    expect(verifySessionToken("not-a-token")).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
  });

  it("签名正确但已过期的令牌被拒绝", () => {
    const expired = forgeToken({
      userId: "user-123",
      expiresAt: Date.now() - 1000,
      nonce: "n",
    });

    expect(verifySessionToken(expired)).toBeNull();
  });

  it("签名正确但缺少 userId 的令牌被拒绝", () => {
    const noUser = forgeToken({ expiresAt: Date.now() + 1e9, nonce: "n" });

    expect(verifySessionToken(noUser)).toBeNull();
  });
});

describe("session cookie", () => {
  it("从 Cookie 头中读出令牌，无头返回 undefined", () => {
    const token = createSessionToken("user-123");
    const header = serializeSessionCookie(token);

    expect(readSessionToken(header)).toBe(token);
    expect(readSessionToken(null)).toBeUndefined();
    expect(readSessionToken("other=1")).toBeUndefined();
  });

  it("登录 Cookie 设置 httpOnly / sameSite=lax / path=/，有效期一周", () => {
    const cookie = serializeSessionCookie(createSessionToken("user-123"));

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
  });

  it("登出 Cookie 立即过期", () => {
    const cookie = serializeExpiredSessionCookie();

    expect(cookie).toContain("Max-Age=0");
    expect(readSessionToken(cookie)).toBe("");
  });
});
