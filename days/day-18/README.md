# Day 18 — NestJS 数据验证与 DTO

## 📋 今日目标

- 搞清楚 DTO 不是 TS 类型，而是带运行时元数据的类
- 理解 `class-validator` + `class-transformer` + `ValidationPipe` 三者的协作
- 掌握 `whitelist` / `transform` / `forbidNonWhitelisted` 三个关键开关的真实作用
- 用 Mapped Types 复用 DTO，避免字段定义漂移
- 给博客 API 加上完整、可维护的请求体校验

## 📖 核心知识点

### 1. 为什么 TypeScript 类型不够用

很多人第一次接触 DTO 会问：我都已经写了 `interface CreatePostDto` 了，为什么还要重复写一遍 class？

```typescript
// 这种写法在运行时毫无防御能力
@Post()
create(@Body() body: CreatePostDto) {
  // body 可能是 {} 也可能是 { title: 123, hack: 'rm -rf /' }
  // TypeScript 类型在 tsc 编译后就不存在了
}
```

TS 的类型在编译期被擦除，HTTP 请求是运行时进来的脏数据。你需要的是一个**运行时还活着的描述对象**，能告诉框架：

- 这个字段必须是字符串
- 长度在 1–100 之间
- 邮箱要符合 RFC 5322

这个"描述对象"在 NestJS 的方案里就是 **class + 装饰器**。装饰器在编译时通过 `reflect-metadata` 把规则写到类的元数据里，运行时被 Pipe 读出来执行校验。这是 class 而不是 interface 的根本原因——interface 编译后什么都不剩。

### 2. 三件套：各自的职责

```
plain object (来自 req.body)
   │
   │  class-transformer：把 JSON 对象转成 DTO 实例
   ▼
DTO instance (CreatePostDto 的实例)
   │
   │  class-validator：读取类上的元数据，逐字段校验
   ▼
valid instance  →  Controller
   │
   │  校验失败抛 BadRequestException
   ▼
400 响应
```

`ValidationPipe` 是把这两个库黏起来的胶水。它实现了 NestJS 的 `PipeTransform` 接口，挂在请求生命周期的「Pipe」阶段（Day 17 讲过：Middleware → Guard → Interceptor → Pipe → Handler）。

### 3. 安装与全局启用

```bash
pnpm add class-validator class-transformer
```

```typescript
// main.ts
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,             // 删除 DTO 里没声明的字段
      forbidNonWhitelisted: true,  // 出现未声明字段直接报错
      transform: true,             // 把 plain 对象转成 DTO 实例 + 基本类型转换
      transformOptions: {
        enableImplicitConversion: true, // query/param 的 string 自动转 number/boolean
      },
    }),
  );

  await app.listen(3000);
}
bootstrap();
```

这三个开关每一个都决定了 API 的"严格度"，下一节单独讲。

### 4. 三个关键开关：到底干了什么

**`whitelist: true`**

只保留 DTO 上声明过的字段，其他字段**静默丢弃**。

```typescript
// DTO 里只有 title 和 content
class CreatePostDto {
  @IsString() title: string;
  @IsString() content: string;
}

// 请求体：{ title: 'a', content: 'b', isAdmin: true }
// whitelist 开启后，进入 Controller 的 body：{ title: 'a', content: 'b' }
// isAdmin 被丢掉，避免了批量赋值漏洞（Mass Assignment）
```

**`forbidNonWhitelisted: true`**

把"静默丢弃"升级为"直接拒绝"，配合 `whitelist` 使用。适合对外的写接口，能让前端尽早发现拼错的字段。

**`transform: true`**

两个作用：
1. 把 plain object 真正 `new` 成 DTO 类的实例（在 Service 里能用 `instanceof`、能调用方法）
2. 配合 `enableImplicitConversion`，把 URL 里的 `?page=2` 从 `'2'` 转成 `2`

```typescript
// 没开 transform 时
@Get()
list(@Query('page') page: number) {
  console.log(typeof page); // 'string' —— TS 撒了个谎
}

// 开了 transform + enableImplicitConversion
console.log(typeof page); // 'number'
```

### 5. 常用装饰器速查

```typescript
import {
  IsString, IsInt, IsBoolean, IsEmail, IsUrl, IsDateString, IsEnum,
  IsOptional, IsNotEmpty, IsArray,
  Length, MinLength, MaxLength, Min, Max,
  Matches, IsIn, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePostDto {
  @IsString()
  @Length(1, 100, { message: '标题长度需在 1-100 之间' })
  title: string;

  @IsString()
  @MinLength(10)
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })  // each: 数组每一项都校验
  @Length(1, 20, { each: true })
  tags?: string[];

  @IsEnum(['draft', 'published', 'archived'])
  status: 'draft' | 'published' | 'archived';

  @IsOptional()
  @IsUrl()
  coverUrl?: string;
}
```

几个容易踩的点：

- `@IsOptional()` 必须放在所有校验器**前面**——它的语义是"如果为 undefined 或 null 就跳过后续校验"。
- `{ each: true }` 是数组项校验开关，没有它 `@IsString()` 只会校验数组本身。
- 自定义 `message` 接受字符串或函数：`message: ({ value }) => \`不支持的值: ${value}\``。

### 6. Mapped Types：DTO 复用

更新接口和创建接口的字段大部分重合，但更新时所有字段都该是可选的。手抄一遍既冗余又容易漂移：

```typescript
import { PartialType, OmitType, PickType, IntersectionType } from '@nestjs/mapped-types';

export class CreatePostDto {
  @IsString() title: string;
  @IsString() content: string;
  @IsEnum(['draft', 'published']) status: string;
}

// 所有字段变可选（保留校验规则）
export class UpdatePostDto extends PartialType(CreatePostDto) {}

// 排除某些字段
export class PublicPostDto extends OmitType(CreatePostDto, ['status'] as const) {}

// 只挑选某些字段
export class PostSummaryDto extends PickType(CreatePostDto, ['title'] as const) {}
```

底层是动态生成新类并把原类上的 `class-validator` 元数据复制过去。这是只能用 class 的另一个理由——interface 无法这样在运行时被"反射改造"。

### 7. 嵌套 DTO 与数组 DTO

请求体里嵌套对象时，`class-validator` 默认不会向下递归，必须显式声明：

```typescript
class AuthorDto {
  @IsString() name: string;
  @IsEmail() email: string;
}

export class CreatePostDto {
  @IsString() title: string;

  @ValidateNested()        // 告诉校验器：进入这个对象继续校验
  @Type(() => AuthorDto)   // 告诉转换器：把这个字段实例化成 AuthorDto
  author: AuthorDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorDto)
  reviewers: AuthorDto[];
}
```

`@Type()` 来自 `class-transformer`，没有它，嵌套对象只是普通 plain object，`@ValidateNested()` 找不到元数据就什么也校验不了——这是嵌套校验静默失效的最常见原因。

### 8. 自定义校验器

业务规则用内置装饰器表达不出来时，写一个：

```typescript
import {
  registerDecorator, ValidationOptions, ValidatorConstraint,
  ValidatorConstraintInterface, ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'IsSlug', async: false })
class IsSlugConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
  }
  defaultMessage(args: ValidationArguments) {
    return `${args.property} 只能包含小写字母、数字和连字符`;
  }
}

export function IsSlug(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsSlugConstraint,
    });
  };
}

// 使用
class CreatePostDto {
  @IsSlug()
  slug: string;
}
```

异步校验（比如查数据库判断唯一性）把 `async: true` 打开，`validate` 返回 `Promise<boolean>`。注意：异步校验会阻塞请求，热路径上慎用，或者放到 Service 里手动处理。

### 9. Pipe 的本质：一个变换器

`ValidationPipe` 不神秘，它实现的接口非常简单：

```typescript
interface PipeTransform<T = any, R = any> {
  transform(value: T, metadata: ArgumentMetadata): R;
}
```

NestJS 在调用 Controller 方法前，对每个被 `@Body() / @Query() / @Param()` 装饰的参数依次执行管道。`transform` 返回什么，Controller 方法收到什么。所以你也能写自己的 Pipe：

```typescript
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, ObjectId> {
  transform(value: string): ObjectId {
    if (!ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ObjectId: ${value}`);
    }
    return new ObjectId(value);
  }
}

// 使用
@Get(':id')
findOne(@Param('id', ParseObjectIdPipe) id: ObjectId) { ... }
```

理解了这一点，`ValidationPipe` 也就是一个稍微复杂的 `transform`——读元数据、调 validator、抛异常或返回实例，仅此而已。

### 10. 校验失败的响应格式

默认错误形态：

```json
{
  "statusCode": 400,
  "message": ["title 不能为空", "content 长度至少为 10"],
  "error": "Bad Request"
}
```

想要更结构化的响应，重写 `exceptionFactory`（Day 19 会接到全局异常过滤器里去）：

```typescript
new ValidationPipe({
  exceptionFactory: (errors) => {
    const formatted = errors.map(err => ({
      field: err.property,
      messages: Object.values(err.constraints ?? {}),
    }));
    return new BadRequestException({ code: 'VALIDATION_ERROR', errors: formatted });
  },
});
```

### 11. 常见坑

- **忘了 `reflect-metadata`**：`tsconfig.json` 需要 `"experimentalDecorators": true` 和 `"emitDecoratorMetadata": true`。NestJS CLI 生成的项目默认带，自己搭项目时容易漏。
- **`@IsOptional()` 顺序错了**：装饰器从下往上执行，但 `@IsOptional` 必须在最上面才能正确"短路"后续规则。
- **嵌套对象没加 `@Type()`**：校验静默通过，看起来一切正常，实则没校验。
- **全局 `transform: true` 误伤**：开启后，`@Body()` 拿到的不再是 plain object，序列化、深拷贝时要注意。
- **DTO 写在 Controller 文件里**：项目变大后非常难找。约定放在 `posts/dto/create-post.dto.ts`。

---

## 💻 实践练习

### 练习 1：给博客 API 加上完整校验

基于 Day 16 / Day 17 的 `blog-api`：

1. 在 `posts/dto/` 下创建 `create-post.dto.ts` 和 `update-post.dto.ts`
2. `UpdatePostDto` 用 `PartialType(CreatePostDto)` 派生
3. `main.ts` 配置全局 `ValidationPipe`，开启 `whitelist` / `forbidNonWhitelisted` / `transform`
4. 用 curl 或 Thunder Client 测试：
   - 缺字段 → 返回 400 + 字段级错误信息
   - 多余字段 → 返回 400
   - 字段类型错误 → 返回 400
   - 合法请求 → 正常创建

### 练习 2：自定义 `@IsSlug()` 装饰器

给文章加上 `slug` 字段，限制为小写字母、数字、连字符。复用本文第 8 节代码。

### 练习 3：嵌套 DTO

文章增加 `meta` 字段（嵌套对象，含 `seoTitle` / `seoDescription`），用 `@ValidateNested()` + `@Type()` 让嵌套字段也走校验。故意漏掉 `@Type()`，观察校验是否生效，体会"静默失效"。

---

## ✅ 今日产出

- [ ] 理解 DTO 是运行时活着的类，不是 TS 类型
- [ ] 掌握 `whitelist` / `forbidNonWhitelisted` / `transform` 的边界
- [ ] 用 Mapped Types 复用 DTO
- [ ] 完成博客 API 的请求体校验
- [ ] 写出一个自定义校验装饰器

## 📚 延伸阅读

- [NestJS 官方文档 - Validation](https://docs.nestjs.com/techniques/validation)
- [class-validator 装饰器列表](https://github.com/typestack/class-validator#validation-decorators)
- [class-transformer 文档](https://github.com/typestack/class-transformer)
- [NestJS 官方文档 - Mapped Types](https://docs.nestjs.com/openapi/mapped-types)

---

[⬅️ Day 17](../day-17/) | [➡️ Day 19](../day-19/)
