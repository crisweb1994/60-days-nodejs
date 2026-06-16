// node --test 的 -r 预加载：在测试文件（以及它们 import 的 AppModule）加载【之前】把测试环境变量就位。
//
// 为什么需要这个文件：
//   @nestjs/config 的 ConfigModule.forRoot() 是在「import AppModule 的那一刻」同步执行的——
//   它会在那时把 process.env 校验、烘焙成配置对象。而 node:test 的 before() 钩子是在
//   测试文件 import 【之后】才跑的，所以「在 before 里设 process.env.GITHUB_CLIENT_ID」太晚了：
//   config 早已把 GITHUB_* 烘焙成 undefined（.env.example 里这两个就是空的），导致 OAuth 一直 503。
//
//   解法：把测试需要的、但 .env 里没有的环境变量，在预加载阶段（早于一切 import）就设好。
//   全部用 ??=：绝不覆盖运行时传入的覆盖值（例如把 DATABASE_URL 指向别的端口的 docker 容器）。
//   ⚠️ 不要在这里设 PORT：env schema 要求 PORT >= 1，而测试靠 app.listen(0) 抢随机端口，
//      并不读 PORT。若设成 '0' 会直接 fail-fast 在启动校验上。
process.env.NODE_ENV ??= 'test';
process.env.CORS_ORIGIN ??= 'http://localhost:5173';
process.env.PAGE_LIMIT ??= '20';
// 默认指向 blog-db 起的 PG（docker 默认 5432）。本地若 5432 被占，运行时传 DATABASE_URL 覆盖即可。
process.env.DATABASE_URL ??=
  'postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=blog_api';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long';
// OAuth 测试需要「已配置」状态，而 .env.example 里这两个故意留空——这里补测试占位值。
process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
process.env.GITHUB_CALLBACK_URL ??= 'http://localhost:3000/auth/github/callback';
