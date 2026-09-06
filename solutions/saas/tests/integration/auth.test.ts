import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
  prisma,
  resetDatabase,
  seedWorld,
  trpcCode,
  uniqueEmail,
} from "./test-utils";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("auth.register", () => {
  it("注册成功并返回脱敏后的用户", async () => {
    const { user } = await callerFor(null).auth.register({
      email: uniqueEmail(),
      password: "password-123456",
      name: "Alice",
    });

    expect(user).toMatchObject({
      email: expect.stringContaining("@test.local"),
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("邮箱大小写与首尾空格先归一再校验唯一性", async () => {
    const email = uniqueEmail("case");
    const anonymous = callerFor(null);

    await anonymous.auth.register({
      email,
      password: "password-123456",
    });

    const error = await anonymous.auth
      .register({
        email: `  ${email.toUpperCase()}  `,
        password: "password-123456",
      })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("CONFLICT");
  });

  it("密码短于 8 位在输入层被拒绝，不会落到数据库", async () => {
    const anonymous = callerFor(null);

    const error = await anonymous.auth
      .register({ email: uniqueEmail(), password: "short" })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("BAD_REQUEST");
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("auth.login", () => {
  it("正确凭据登录成功，错误凭据得到同一个错误", async () => {
    const email = uniqueEmail();
    const password = "password-123456";
    await callerFor(null).auth.register({ email, password });

    const anonymous = callerFor(null);
    const ok = await anonymous.auth.login({ email, password });
    expect(ok.user.email).toBe(email);

    const wrongPassword = await anonymous.auth
      .login({ email, password: "password-654321" })
      .catch((error: unknown) => error);
    const unknownEmail = await anonymous.auth
      .login({ email: uniqueEmail("ghost"), password })
      .catch((error: unknown) => error);

    expect(trpcCode(wrongPassword)).toBe("UNAUTHORIZED");
    expect(trpcCode(unknownEmail)).toBe("UNAUTHORIZED");
    expect((wrongPassword as Error).message).toBe(
      (unknownEmail as Error).message,
    );
  });
});

describe("auth.me 与会话边界", () => {
  it("未登录调用 protectedProcedure 返回 UNAUTHORIZED", async () => {
    const error = await callerFor(null)
      .auth.logout()
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("UNAUTHORIZED");
  });

  it("登录用户可以读取自己的信息", async () => {
    const { caller, user } = await seedWorld();

    const me = await caller.auth.me();
    expect(me.user?.id).toBe(user.id);
  });
});
