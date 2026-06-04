# auth-basics — Day 31 认证基础 playground

把 JWT 拆开看、把 Session 和 JWT 摆一起对比。**零运行时依赖**——手写 JWT 只用 Node 内置的 `node:crypto`，目的就是看穿结构，而不是造轮子（生产请用 `@nestjs/jwt`，Day 32 会用）。

## 跑 demo

```bash
pnpm install
pnpm demo:anatomy          # 01：拆解一个 JWT —— 三段结构 / 防篡改 / 不能放秘密 / 过期
pnpm demo:session-vs-jwt   # 02：Session vs JWT —— 登出/撤销的本质差异
pnpm demo:all              # 全跑
pnpm typecheck             # tsc --noEmit
```

## 文件

```
src/
├── jwt.ts                 # 手写 HS256 JWT：sign / verify / decode（base64url + HMAC）
├── 01_jwt_anatomy.ts      # JWT 是 base64url(header).base64url(payload).base64url(签名)
└── 02_session_vs_jwt.ts   # 有状态 vs 无状态，以及 JWT 为什么难「即时撤销」
```

## 一句话总结

- **JWT 不是加密**：payload 任何人都能 base64 解开。它能被信任靠的是**签名防篡改**，不是保密——别往里塞敏感数据。
- **Session**：服务端存会话，登出=删记录，**即时撤销**，代价是有状态（要存要查）。
- **JWT**：服务端不存，信任全在 token 自带的签名 + `exp`；**省了存储，但换不来即时撤销**（要撤销就得加黑名单，等于把状态加回来）。

详细讲解见 [Day 31 README](../../days/day-31/)。Day 32 会把这些接进 blog-api：bcrypt 存密码、Access/Refresh 双 Token。
