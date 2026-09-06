import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "@/server/domain/cursor";

// cursor 是发给客户端的不透明令牌：客户端会原样回传，
// 也会有人出于好奇或攻击目的改写它。除了 roundtrip，
// 更重要的是它对畸形输入的态度——必须抛错而不是悄悄给出半吊子结果。
describe("encodeCursor / decodeCursor", () => {
  it("编码后再解码得到原值", () => {
    const cursor = {
      value: "2026-07-24T10:00:00.000Z",
      id: crypto.randomUUID(),
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("数字 value（按 number 排序的列表）同样可往返", () => {
    const cursor = { value: 42, id: crypto.randomUUID() };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("输出是 URL 安全的 base64，可以直接放进查询参数", () => {
    const encoded = encodeCursor({
      value: "2026-07-24T10:00:00.000Z",
      id: crypto.randomUUID(),
    });

    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("拒绝非 base64url 的输入", () => {
    expect(() => decodeCursor("not-a-cursor!!")).toThrow();
  });

  it("拒绝合法 base64 但内容不是 cursor 的输入", () => {
    const payload = Buffer.from(JSON.stringify({ hello: "world" })).toString(
      "base64url",
    );

    expect(() => decodeCursor(payload)).toThrow();
  });

  it("拒绝 value/id 结构正确但 id 不是 UUID 的输入", () => {
    const payload = Buffer.from(
      JSON.stringify({ value: 1, id: "not-a-uuid" }),
    ).toString("base64url");

    expect(() => decodeCursor(payload)).toThrow();
  });
});
