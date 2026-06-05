# Day 33 — RBAC 权限模型

> Day 32 解决了**认证**（你是谁）。Day 33 解决**授权**（你能干什么）：给 posts 加权限——
> 创建要登录、改/删要是作者本人或 admin，外加一个纯角色的 admin-only 接口。

## 📋 今日目标

- 分清两类授权判断，并把它们放对地方：**角色（上下文无关）→ Guard**，**资源所有权（要数据）→ Service**
- 用 `@Roles` + `RolesGuard` + `Reflector` 实现纯 RBAC 角色校验
- 实现**资源级权限**：用户只能改自己的文章，admin 能改任意
- 给 posts 的写接口接上认证 + 授权（读接口保持公开）
- 搞清 401 vs 403 的语义，以及 404/403 的先后
- 踩一个真实的跨模块 DI 坑：`@UseGuards` 的守卫在**哪个模块**被实例化

> 配套代码：`solutions/blog/blog-api/`。posts 加了 `author`，写接口加守卫；auth 加 `RolesGuard` + `GET /auth/users`（admin-only）。

---

## 📖 核心知识点

### 1. 授权 ≠ 认证（接 Day 31）

- **认证（authn）**：核对身份。Day 32 的 JWT 做完了——`req.user = { sub, role }`。
- **授权（authz）**：已知身份后，判断**能不能做这件事**。今天的活。

授权常见两种判断，**放的地方不一样**，这是今天最重要的设计点：

| 判断类型 | 例子 | 需要什么 | 放哪 |
|---|---|---|---|
| **角色**（上下文无关）| "只有 admin 能列用户" | 只看 `user.role` | **Guard**（守卫层就能判，请求还没进 handler）|
| **资源所有权**（上下文相关）| "只有作者能改这篇文章" | 要先**把文章查出来**看 `authorId` | **Service**（数据在这层，顺手判）|

口诀：**角色判断上守卫，所有权判断进 Service**。别硬把"要查资源"的判断塞进守卫——守卫为了拿 authorId 得自己查一次库，既越权又重复。

### 2. RBAC 模型

**RBAC（Role-Based Access Control）**：不直接给"用户"授权，而是给"角色"授权，用户绑定角色。

```
用户 ──属于──> 角色（user / admin）──拥有──> 权限（能做哪些操作）
```

本项目极简：两个角色 `user` / `admin`，`role` 存在 `users` 表，登录时写进 JWT payload（`{ sub, role }`）。守卫直接读 token 里的 `role`，**不查库**（无状态认证的红利）。

> 怎么成为 admin？没有"自助升级"接口（那是漏洞）。运维手动改库 / Prisma Studio：`UPDATE users SET role='admin' WHERE ...`。更大的系统会有专门的用户管理后台。

### 3. @Roles + RolesGuard：纯角色守卫

两步。装饰器把"要求的角色"挂成元数据：

```typescript
// roles.decorator.ts
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

守卫用 `Reflector` 读出来比对：

```typescript
// roles.guard.ts
canActivate(ctx: ExecutionContext): boolean {
  const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
    ctx.getHandler(), ctx.getClass(),   // 方法级优先于类级
  ]);
  if (!required?.length) return true;   // 没声明 @Roles = 不限角色，放行
  const user = ctx.switchToHttp().getRequest().user; // JwtAuthGuard 已填好
  if (!user) throw Unauthorized;        // 守卫顺序错了才会到这
  if (!required.includes(user.role)) throw Forbidden;
  return true;
}
```

用起来（**守卫顺序要对**）：

```typescript
@Get('users')
@UseGuards(JwtAuthGuard, RolesGuard)   // 先认证（填 req.user），再校验角色
@Roles('admin')
listUsers() { ... }
```

**关键点**：
- `getAllAndOverride([handler, class])`：方法上的 `@Roles` 覆盖类上的，灵活。
- **顺序**：`JwtAuthGuard` 必须排在 `RolesGuard` 前面——后者依赖前者填好的 `req.user`。
- 没 `@Roles` 的路由，RolesGuard 直接放行（它只管"被显式限制角色"的路由）。

### 4. 资源级权限：放在 Service

"只有作者能改自己的文章"需要那篇文章的 `authorId`，守卫拿不到（除非自己查库）。所以放在 Service——它本来就要 `findOne` 把文章查出来：

```typescript
// posts.service.ts
private assertCanModify(post: Post, actor: Actor) {
  if (actor.role === 'admin') return;                    // admin 改任意
  if (post.authorId && post.authorId === actor.sub) return; // 作者本人
  throw new BusinessException(FORBIDDEN, '只有作者或管理员可以修改', 403);
}

async update(id, dto, actor) {
  const post = await this.findOne(id);  // 404 优先于 403，且拿到 authorId
  this.assertCanModify(post, actor);     // ← 资源级权限
  // ... 归档检查、slug 检查、乐观锁更新 ...
}
```

- **admin 短路放行**：角色高于所有权。
- **无主文章**（`authorId` 为空，迁移前的老数据）只有 admin 能改——`post.authorId &&` 那个判断兜住了 null。
- **创建时设作者**：`create(dto, authorId)`，`authorId = 当前登录用户`。

### 5. 给 posts 接上守卫（读公开 / 写要登录）

```typescript
// 读：公开，不挂守卫
@Get() / @Get(':id') / @Get(':id/revisions') / @Post(':id/view')  // 浏览计数也匿名可用

// 写：@UseGuards(JwtAuthGuard)，再在 Service 做所有权
@Post()        create(@Body() dto, @CurrentUser() user) → posts.create(dto, user.sub)
@Patch(':id')  update(@Param id, @Body dto, @CurrentUser() user) → posts.update(id, dto, user)
@Delete(':id') remove(@Param id, @CurrentUser() user) → posts.remove(id, user)
```

为什么读保持公开：博客文章本来就给所有人看。要"草稿仅作者可见"那种**字段级 / 行级可见性**是更细的活，可按需加（按 `status` + `authorId` 过滤）。

### 6. 401 vs 403 vs 404

HTTP 语义要分清，前端据此决定"跳登录"还是"提示无权"：

- **401 Unauthorized**：其实是"**未认证**"——没带 token / token 无效。→ 前端跳登录。
- **403 Forbidden**：已认证，但**没权限**做这事。→ 前端提示"无权限"。
- **404 vs 403 的先后**：本项目 `update`/`remove` 先 `findOne`（不存在 → 404），再判权限（→ 403）。因为 posts 是**公开可读**的，"这篇文章存在"本来就不是秘密，先 404 没有信息泄露问题。**若资源本身要保密**（如私信），则应反过来——对无权用户一律 404，不暴露"它存在"。

### 7. 真实的坑：守卫在哪个模块被实例化（跨模块 DI）

这个坑今天实打实踩到了。`PostsController` 用 `@UseGuards(JwtAuthGuard)`，而 `JwtAuthGuard` 住在 `AuthModule`、依赖 `JwtService`。直觉上"AuthModule 导出 JwtAuthGuard，PostsModule import 一下"就行——**不够**：

> `@UseGuards(SomeGuard)` 是在**控制器所在的模块**（PostsModule）里实例化守卫的。所以守卫的依赖（`JwtService`）必须在 **PostsModule 的上下文**里可解析。只导出守卫类不够，得把 **`JwtModule` 也 re-export** 出去：

```typescript
// auth.module.ts
@Module({
  imports: [PrismaModule, JwtModule.registerAsync({ ... })],
  providers: [..., JwtAuthGuard, RolesGuard],
  exports: [JwtAuthGuard, RolesGuard, JwtModule], // ← 必须带上 JwtModule
})
export class AuthModule {}

// posts.module.ts
@Module({ imports: [PrismaModule, AuthModule], ... })  // 这下 JwtService 在 PostsModule 也能解析
```

不这么做，启动直接报 `Nest can't resolve dependencies of the JwtAuthGuard (?) ... JwtService ... in the PostsModule context`，应用根本起不来。**记住这条：守卫的依赖要在用守卫的那个模块里能解析。**

> 另一种思路：把 `JwtAuthGuard` 设成全局守卫（`APP_GUARD`）+ 用 `@Public()` 装饰器把公开路由标出来——"**默认安全**"。本项目选了"逐路由 @UseGuards"求显式；大项目常用全局 + @Public。

### 8. 数据迁移：authorId 可空

给已有 `posts` 表加 `author_id`，用了 **可空 + `ON DELETE SET NULL`**：
- **可空**：迁移前建的老文章没有作者，硬加 `NOT NULL` 会让 migration 在非空表上失败。可空让它们成为"无主"（只有 admin 能改）。
- **SET NULL**：删用户时，把他文章的 `author_id` 置空，而不是连文章一起删（`Cascade`）——博客一般不希望删号连带删文。

---

## 💻 实践练习

### 主练习：给 blog-api 加 RBAC

在 `solutions/blog/blog-api/` 上完成：

1. schema 给 `Post` 加可空 `authorId`（FK→User，SetNull）；`prisma migrate dev`
2. `auth/decorators/roles.decorator.ts` + `auth/guards/roles.guard.ts`
3. `AuthModule` 把 `RolesGuard` 加进 providers，`exports` 带上 `JwtAuthGuard / RolesGuard / JwtModule`
4. `GET /auth/users`：`@UseGuards(JwtAuthGuard, RolesGuard) @Roles('admin')`
5. `PostsService`：`create(dto, authorId)` 设作者；`update/remove` 加 `assertCanModify`（owner/admin）
6. `PostsController`：写接口 `@UseGuards(JwtAuthGuard)` + `@CurrentUser()`；读接口保持公开
7. `PostsModule` import `AuthModule`

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -
cp .env.example .env
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

pnpm start:dev
pnpm test:unit       # 35（含 RolesGuard + 资源级权限）
pnpm test:e2e        # 串行跑（--test-concurrency=1）
```

手动验证：

```bash
# 注册两个用户，各拿 token
A=$(curl -s -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d '{"email":"a@x.com","username":"alice","password":"Pass-1234"}' | jq -r .data.accessToken)
B=$(curl -s -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d '{"email":"b@x.com","username":"bob","password":"Pass-1234"}' | jq -r .data.accessToken)

# alice 建文章
ID=$(curl -s -X POST localhost:3000/posts -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"title":"t","slug":"s","content":"long enough content","status":"draft"}' | jq -r .data.id)

curl -s -X POST localhost:3000/posts -d '{...}' | jq '{code}'                         # 不带 token → 401
curl -s -X PATCH localhost:3000/posts/$ID -H "Authorization: Bearer $B" -H 'Content-Type: application/json' -d '{"title":"hijack"}' | jq '{code}'  # bob 改 alice 的 → 403
curl -s -X PATCH localhost:3000/posts/$ID -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"title":"ok"}' | jq '.data.title' # 作者本人 → 200
curl -s localhost:3000/auth/users -H "Authorization: Bearer $A" | jq '{code}'         # 非 admin → 403
```

### 加分练习：自己想答案再看

1. **把 JwtAuthGuard 设成全局 `APP_GUARD` + `@Public()`**：哪些路由要标 `@Public`？对比"逐路由 @UseGuards"。
2. **为什么所有权判断不放守卫？** 如果硬放守卫，守卫怎么拿到文章的 `authorId`？代价是什么？
3. **私密资源的 404 策略**：把 posts 改成"草稿只有作者可见"，无权用户访问草稿该 404 还是 403？为什么？
4. **细化角色**：加一个 `editor` 角色，能改任何人的文章但不能删。`@Roles` 和 `assertCanModify` 各怎么改？
5. **复现 DI 坑**：把 `auth.module.ts` 的 `exports` 去掉 `JwtModule`，看启动报什么错。

### 验收清单

```bash
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK types"
pnpm test:unit    # 35
pnpm test:e2e     # posts 33（含 401/403/owner/admin）+ auth 16（含 /auth/users admin-only）
pnpm test:e2e 2>&1 | grep -iE 'FORBIDDEN|401|admin|作者|别人'
```

---

## ⚠️ 常见误区

- **把所有权判断塞进守卫**：守卫拿不到资源数据，硬塞就得自己查库。资源级权限放 Service。
- **守卫顺序写反**：`@UseGuards(RolesGuard, JwtAuthGuard)` → RolesGuard 跑时 `req.user` 还没填 → 误判。先认证后授权。
- **401 当 403 用**：401=未认证（跳登录），403=已认证但无权（提示无权）。别混。
- **跨模块用守卫只导出守卫类**：`@UseGuards` 在控制器模块实例化守卫，守卫的依赖（JwtService）也得在那模块可解析——re-export `JwtModule`。
- **给已有表加 `authorId NOT NULL`**：非空表迁移直接失败。可空 + 让老数据"无主"。
- **删用户级联删文章**：一般不想要。用 `SET NULL`，文章保留、作者置空。
- **角色塞进 token 后改了库不生效**：role 在签发时写进 JWT，改库后要等 token 过期/刷新才更新——这是无状态的固有取舍。敏感场景用短 access + 刷新时取最新角色。
- **以为 admin 能绕过乐观锁/归档**：本项目 admin 只绕过**所有权**，归档/版本冲突等业务规则照样生效（assertCanModify 之后还有那些检查）。

---

## ✅ 今日产出

- [ ] 能区分角色判断（守卫）和资源所有权判断（Service），并说出为什么这样分
- [ ] `@Roles` + `RolesGuard` 可用，守卫顺序正确
- [ ] posts 写接口需登录；改/删是作者本人或 admin；读公开
- [ ] 能说清 401/403/404 的语义和先后
- [ ] 理解"守卫在控制器所在模块实例化"，会 re-export 依赖模块
- [ ] 单测（35）+ 集成测（posts 33 / auth 16）全绿
- [ ] 提交到 GitHub，commit message 写明 "day 33 rbac: roles guard + ownership"

---

## 📚 延伸阅读

- [NestJS — Authorization（RBAC）](https://docs.nestjs.com/security/authorization)
- [NestJS — Guards](https://docs.nestjs.com/guards)（执行顺序、Reflector、全局守卫）
- [NestJS — Custom decorators（SetMetadata / Reflector）](https://docs.nestjs.com/custom-decorators)
- [OWASP — Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP — Broken Access Control（A01:2021）](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)（授权出错是头号 Web 风险）
- [RBAC vs ABAC](https://www.osohq.com/learn/rbac-vs-abac)（角色 vs 属性，何时升级到 ABAC）

---

[⬅️ Day 32](../day-32/) | [➡️ Day 34](../day-34/)
