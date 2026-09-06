import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/server/auth/password";

// 密码哈希是安全边界：测的不是“能算出结果”，
// 而是格式约定、失败路径和随机盐这些出问题时用户无感知的细节。
describe("hashPassword / verifyPassword", () => {
  it("同一密码两次哈希产生不同结果（盐是随机的）", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
  });

  it("哈希格式为 algorithm:salt:derivedKey，算法标记为 scrypt", async () => {
    const hash = await hashPassword("s3cret-password");

    expect(hash.startsWith("scrypt:")).toBe(true);
    expect(hash.split(":")).toHaveLength(3);
  });

  it("正确密码验证通过，错误密码验证失败", async () => {
    const hash = await hashPassword("s3cret-password");

    expect(await verifyPassword("s3cret-password", hash)).toBe(true);
    expect(await verifyPassword("s3cret-password ", hash)).toBe(false);
    expect(await verifyPassword("S3cret-password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("数据库里没有密码（OAuth 用户）时直接失败，不抛错", async () => {
    expect(await verifyPassword("whatever", null)).toBe(false);
  });

  it("被篡改或格式损坏的存量哈希验证失败，而不是抛异常", async () => {
    expect(await verifyPassword("s3cret-password", "")).toBe(false);
    expect(await verifyPassword("s3cret-password", "plaintext")).toBe(false);
    expect(await verifyPassword("s3cret-password", "bcrypt:abc:def")).toBe(
      false,
    );
    // hex 解不出来只会得到空 buffer，split 结果为空段
    expect(await verifyPassword("s3cret-password", "scrypt::zzz")).toBe(false);
  });
});
