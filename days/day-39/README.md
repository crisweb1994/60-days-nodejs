# Day 39 — 文件上传与存储

> 到 Day 38 为止，我们经手的数据都是「结构化」的——JSON 请求体、SQL 行、缓存里的字符串。它们有个共同点：**小、可信、能塞进数据库**。
>
> 这一天要处理一类完全不同的东西：**用户上传的二进制文件**（封面图、头像、附件）。它把前面几天没碰过的麻烦一股脑端上来：体积大（一张图顶一万条 JSON）、不可信（上传者可能塞恶意内容）、不能进数据库（几百 MB 的 blob 塞 PG 是灾难）、HTTP 层要用 `multipart/form-data` 传（和 JSON 完全是两套解析）。博客没封面图就像没装修的毛坯房——这一天的目标就是给它「挂上画」：用 **Multer** 收文件、**Sharp** 核验并归一化图片、**S3 兼容对象存储**（Cloudflare R2 / MinIO / AWS S3）落地，再把这套能力抽象成「换后端只动一行」的样子。

## 📋 今日目标

- 搞懂 **`multipart/form-data`** 为什么和 JSON 不一样，**Multer** 在 Express/Nest 里扮演什么角色
- 做一个**存储后端抽象**：本地磁盘 ↔ S3 兼容对象存储自由切换，体会它和 Day 20 的 `PostsRepository` 是同一种「防腐层」思路
- 理解为什么 **AWS S3 / Cloudflare R2 / MinIO 能用同一个客户端**——S3 协议成了事实标准，区别只在 endpoint 和「路径风格 vs 虚拟主机风格」
- 用 **Sharp** 做图片**核验 + 归一化**：挡住「改名伪装」的上传攻击，统一尺寸/格式省带宽
- 把上传当成**安全问题**对待：体积上限、MIME 白名单、字节级核验、文件名脱敏、目录穿越、鉴权——纵深防御的完整清单
- 把存储放进这套代码一以贯之的「**可选基础设施**」哲学，并说清它和 Redis/队列的降级姿势**为什么相反**

> 配套代码：`solutions/blog/blog-api/`。新增 `src/storage/` 目录：`storage.service.ts`（抽象 + 类型）、`local-storage.service.ts`（本地磁盘，默认后端）、`s3-storage.service.ts`（S3 兼容，R2/MinIO/AWS）、`image-processor.service.ts`（Sharp 核验+归一化）、`cover-upload.interceptor.ts`（配置驱动的 Multer 拦截器）、`storage.module.ts`（@Global，按 env 选后端）；
> `PostsService` 新增 `uploadCover`（核验→处理→存储→落库→清旧图）；`PostsController` 新增 `POST /posts/:id/cover`；仓储加 `setCoverImage`（不 bump version、不写修订）；`PostMeta` 加 `coverImage`；配置新增 `storage` 块；新增 `test/upload.e2e.test.ts`。

---

## 📖 核心知识点

### 1. 这天在解决什么：二进制上传和结构化数据哪里不一样

先把「上传一张图」和「发一篇 JSON 文章」的差别摆出来，今天的每一节都在回答这张表里的问题：

| 维度 | JSON 文章（前面几天） | 文件上传（今天） |
|---|---|---|
| 编码 | `application/json`，整条请求是一段文本 | `multipart/form-data`，请求被切成多个 **part**（边界分隔），文件 part 是原始字节 |
| 体积 | KB 级 | MB 级，得有**硬上限**防内存被打爆 |
| 可信度 | 框架校验过字段 | **不可信**：可能是改名伪装的恶意文件、超大的图片炸弹、伪造的 Content-Type |
| 落地 | 进数据库 | **不进数据库**——进文件系统或对象存储，DB 只存它的「地址」（URL） |
| 解析 | `JSON.parse` 一把梭 | 得逐 part 流式解析（Multer 干这个） |

一句话总纲：**文件上传不是「再写一个 CRUD」，而是一条带安全闸门的管道**——收（Multer）、验（体积/MIME/字节）、化（Sharp 归一化）、存（对象存储）、记（DB 只存 URL）。

### 2. multipart/form-data 与 Multer：为什么 JSON 那套不灵了

普通 POST 的请求体是一整段 JSON，框架一把 `JSON.parse` 就行。但传文件时，请求长这样：

```
POST /posts/123/cover HTTP/1.1
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk

------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name="file"; filename="cover.png"
Content-Type: image/png

<这里是 PNG 的原始字节，可能是几 MB>
------WebKitFormBoundary7MA4YWxk--
```

边界（`boundary`）把请求切成多个 part，每个 part 有自己的头和体。**这一坨不是 JSON**——`JSON.parse` 无能为力。Multer 就是来解析它的：它逐 part 流式读取，把文本 part 挂到 `req.body`、文件 part 挂到 `req.file`。

> 这也解释了一个初学者的困惑：**为什么不能用 `@Body()` 拿到上传的文件**。`@Body` 走的是 JSON/urlencoded 解析器，遇到 multipart 直接抓瞎。文件得用 Multer 接管那条路由的解析。

在 Nest 里收单文件，标准姿势是 `FileInterceptor`：

```ts
@Post(':id/cover')
@UseInterceptors(FileInterceptor('file', options)) // 字段名 'file'；options 见下
uploadCover(@UploadedFile() file: Express.Multer.File, ...) { ... }
```

但 `FileInterceptor('file', options)` 的 `options` 是**装饰器参数**——在类定义（import）那一刻就要求值，那时还没法注入 `ConfigService`，拿不到 env 里的 `UPLOAD_MAX_BYTES`。要「配置驱动」的 `limits` / `fileFilter`，标准做法是写一个 `NestInterceptor`，在里面用注入进来的 config **现场**构造 Multer 实例（`src/storage/cover-upload.interceptor.ts`）：

```ts
intercept(context, next) {
  const upload = multer({
    storage: multer.memoryStorage(),         // 先进内存，交给 Sharp 处理完再落盘
    limits: { fileSize: this.maxBytes },     // ★ 硬上限：超了在【缓冲阶段】就中断，不会把整坨大文件读进来
    fileFilter: (_req, file, cb) => {        // 早拦截：Content-Type 不在图片白名单直接拒
      if (ALLOWED_IMAGE_MIME.has(file.mimetype)) cb(null, true);
      else cb(new Error('UNSUPPORTED_IMAGE_TYPE'));
    },
  }).single('file');
  return new Observable((sub) => upload(req, res, (err) => {
    if (err) sub.error(this.toBizError(err));  // Multer 抛错 → 翻译成统一业务异常
    else next.handle().subscribe(sub);
  }));
}
```

两个关键选择，各自挡一类坑：

- **`memoryStorage()`** 而不是 `diskStorage`：文件先进内存缓冲，这样紧接着能交给 Sharp 处理（缩放/转格式），处理完的**结果**再落盘/传 S3。如果用 `diskStorage` 直接落用户上传的原始文件，还得再去读回来处理，多一次 IO，而且「原始文件」会短暂留在磁盘上（含潜在恶意内容）。内存缓冲的代价是「单文件占内存」——所以 `limits.fileSize` 这道闸不能少：它在缓冲阶段就掐断超大文件，不让它把内存灌满。
- **`limits.fileSize` 超限会抛 `MulterError(LIMIT_FILE_SIZE)`**，不是走我们的业务异常外壳。所以拦截器里有个 `toBizError` 把它翻译成 `413 UPLOAD_TOO_LARGE`，和其它错误一样走统一外壳（`src/storage/cover-upload.interceptor.ts`）。

### 3. 存储后端抽象：本地磁盘 ↔ S3，换个后端只动一行

文件处理好了，往哪儿存？两条路：本地磁盘、对象存储。它们的差别正好是 Day 20 那个 `PostsRepository`（内存版 ↔ Prisma 版）的同款问题——**换实现不该动业务**。于是同样的解法：抽一个接口，业务只依赖接口，具体实现由模块按配置注入（`src/storage/storage.service.ts`）：

```ts
export abstract class StorageService {
  abstract readonly backend: 'local' | 's3';
  abstract readonly available: boolean;
  abstract save(input: SaveInput): Promise<StoredFile>;   // 字节 + key → 对外 URL
  abstract delete(key: string): Promise<void>;
  abstract exists(key: string): Promise<boolean>;
  abstract publicUrl(key: string): string;
  abstract keyFromPublicUrl(url: string): string | null;    // URL 反推 key，删旧图用
}
```

`StorageModule` 在启动时按 env 选实现挂到 `STORAGE_SERVICE` 这个 token 上（`src/storage/storage.module.ts`）：

```ts
{
  provide: STORAGE_SERVICE,
  inject: [ConfigService],
  useFactory: (config) => {
    if (config.get('storage.backend', { infer: true }) === 's3') {
      if (!config.get('storage.s3.bucket', { infer: true })) {
        throw new Error('STORAGE_BACKEND=s3 但未配置 S3_BUCKET —— ...');   // fail-fast，见 §6
      }
      return new S3StorageService(config);
    }
    return new LocalStorageService(config);   // 默认：本地磁盘，零配置可用
  },
},
```

`PostsService` 只认 `STORAGE_SERVICE`，完全不知道字节落在哪。**这就是「防腐层」的复用**：Day 20 防的是 ORM（Prisma/Drizzle），今天防的是存储后端（磁盘/S3）。模式一模一样，因为问题是同构的。

**为什么默认是本地磁盘**：零配置、不依赖外部服务、测试和本地开发都能跑。但生产几乎不会用它——原因见 §6 的「多实例共享」。

### 4. S3 兼容：为什么 R2 / MinIO / AWS 能用同一个客户端

这是今天最省力也最值钱的一个认知：**S3 的 API 成了对象存储的事实标准**。Cloudflare R2、MinIO、阿里云 OSS、Backblaze B2……全都实现了同一套操作（`PutObject` / `GetObject` / `DeleteObject` / `HeadObject`）。所以一个 `@aws-sdk/client-s3` 的 `S3Client`，换个 endpoint 就能打遍三家（`src/storage/s3-storage.service.ts`）：

```ts
this.client = new S3Client({
  region: config.get('storage.s3.region', { infer: true }),
  endpoint: this.endpoint,               // R2: https://<account>.r2.cloudflarestorage.com；MinIO: http://localhost:9000；AWS: 留空
  forcePathStyle: this.forcePathStyle,   // 见下
  credentials: { accessKeyId, secretAccessKey },
});
```

三家的差别，说穿了就两个旋钮：

| 提供商 | endpoint | forcePathStyle | URL 形态 |
|---|---|---|---|
| AWS S3 | 留空（用区域端点） | `false` | 虚拟主机：`<bucket>.s3.<region>.amazonaws.com/<key>` |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `false` | `<endpoint>/<bucket>/<key>`（或挂 R2 公开域名） |
| MinIO / 自建 | `http://localhost:9000` | **`true`** | 路径风格：`<endpoint>/<bucket>/<key>` |

`forcePathStyle` 是唯一容易踩的坑：MinIO 这类**不支持虚拟主机风格**（`<bucket>.localhost:9000` 解析不了），必须 `true` 走路径风格（`localhost:9000/<bucket>/...`）；R2/AWS 用 `false`。配错的表现是「连得上但 403 / 域名解析失败」，对不上号时第一个怀疑它。

**为什么对象存储比本地磁盘适合生产**，一句话：多实例共享。N 个 Pod 读写同一个 bucket，文件全局可见；本地磁盘的文件别的 Pod 看不见——上传到了 A 实例的磁盘，请求落到 B 实例就 404。这和 Day 37 讲的「缓存击穿只在单进程内有效」是同一个道理：**进程内的状态（内存锁、本地磁盘）在多副本部署里都会失效，得放到所有副本共享的地方（Redis、对象存储）。**

### 5. Sharp：把「上传」当安全问题对待的核验 + 归一化

收到字节后、落地前，还有一道必做的工序：**核验这是不是真图，并把它归一化**（`src/storage/image-processor.service.ts`）。这一步是「纵深防御」的核心——前端校验只是体验优化，绕过它直发 multipart 的成本约等于零，**后端必须自己核验**。

```ts
async processCover(buffer: Buffer): Promise<ProcessedImage> {
  // ① 读真实元信息——解析失败 = 不是图。这一步把「信任浏览器报的 Content-Type」
  //    换成「信任文件真实字节」。
  const meta = await sharp(buffer).metadata().catch(() => null);
  if (!meta || !meta.width || !meta.height) {
    throw new BusinessException(ErrorCodes.INVALID_FILE, '文件不是合法的图片...', 422);
  }
  // ② 归一化：按 EXIF 旋正 → 限最大宽（不放大）→ 转目标格式（默认 webp）。
  const { data, info } = await sharp(buffer)
    .rotate()                                    // 0 参数 = 按 EXIF Orientation 自动旋正（手机竖拍不倒）
    .resize({ width: maxWidth, withoutEnlargement: true })  // 小图不放大
    .toFormat(format, { quality: 82 })           // 82 是 webp/jpeg 体积/质量的常见甜点
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: `image/${info.format}`, ext, width, height, format };
}
```

它一次性解决三件事，每件都对应一个真实攻击/痛点：

1. **核验「真是图」**：经典上传漏洞是攻击者把 `evil.php` 改名 `evil.jpg`、或给恶意脚本顶个 `image/jpeg` 头。Multer 的 `fileFilter` 只看浏览器**自报**的 `mimetype`，挡不住改名。Sharp 读取时会解析真实像素结构——**解析不出 width/height 就不是合法图**，直接拒。这就是「Content-Type 不可信，要信字节」。
2. **归一化省带宽**：把任意大图压到最大宽度（默认 1600px）、转成 webp。否则用户传个 8000×8000 的原图，列表页会被撑爆、流量费爆炸。`withoutEnlargement: true` 保证小图不会被无意义放大。
3. **EXIF 旋正**：手机竖拍的照片常带 EXIF `Orientation` 标志，浏览器 `<img>` 会自动转，但很多后端预览/裁剪不会，结果歪着。`.rotate()` 按 EXIF 旋正，存出去就是正的。

> 故意**不收 `image/svg+xml`**：SVG 本质是 XML，能内嵌 `<script>`，前端拿它当 `<img src>` 渲染是 XSS 面（甚至能触发 SSRF / 读取 DOM）。光栅图（jpeg/png/webp）没这风险。MIME 白名单里因此排除了 SVG（`src/storage/storage.constants.ts`）。

到这里可以把「上传安全」的纵深防御清单钉死了——**每一层都假设前一层被绕过**：

| 层 | 挡什么 | 在哪 |
|---|---|---|
| **体积上限** `limits.fileSize` | 图片炸弹 / 内存打爆 | Multer（缓冲阶段就掐断） |
| **MIME 白名单** `fileFilter` | 非 图片类型（pdf/exe） | Multer（早拦截，省后续处理） |
| **字节级核验** Sharp metadata | 改名伪装的恶意文件 | ImageProcessor |
| **key 用 uuid，不用用户文件名** | 目录穿越 / 覆盖 / 文件名信息泄露 | PostsService.uploadCover |
| **目录穿越二次校验** `safeAbs` | `../` 逃出根目录 | LocalStorageService（删除/存在性路径） |
| **鉴权** 作者本人或 admin | 越权往别人文章挂图 | PostsService（404 优先于 403） |

「key 用 uuid」这一条值得单独点一句：用户上传的 `filename` **只用作展示参考，绝不进存储路径**。落盘 key 是服务端生成的 `covers/<postId>/<uuid>.<ext>`（`src/posts/posts.service.ts`）。这一举多得：防 `../` 目录穿越、防同名覆盖、防文件名里的敏感信息（用户名、内部路径）泄露。响应里的 `meta.coverImage` 也因此是 `…/<uuid>.webp`，**回不出原始文件名**。

### 6. 优雅降级 vs fail-fast：存储为什么和 Redis 哲学相反

这一节是这套代码「一以贯之」的设计观，也是今天最容易和前两天搞混的点。

先回顾前两天：Redis 缓存、BullMQ 队列，都是**「真相源之外的可选层」**——连不上就**静默降级**（缓存 miss 直查库、入队失败照常注册成功），绝不拖垮主流程。那句口号是「挂了只是变慢/变差，不能挂」。

存储**也是**真相源之外的一层，但它的降级姿势**不一样**：

- **默认（local）**：永远可用，零配置。这是它的「优雅」形态——不需要任何外部服务。
- **一旦显式选了 S3**（`STORAGE_BACKEND=s3`）：这不再是「辅助层挂了无所谓」，而是**运营决定**——你主动选择了把用户文件放在外部对象存储。这时**配错（缺 `S3_BUCKET`）应该启动即崩**，而不是悄悄降级。否则用户开开心心上传，传完才发现没地方存，数据丢失且无感知，这是最糟的失败模式。

所以 `StorageModule` 的 `useFactory` 里，选了 S3 但没配 bucket，直接 `throw`（见 §3）。这和 `RedisService` 的 `try/catch 当缓存不存在` 是**刻意相反**的两套姿势。一句话区分：

> **辅助层的瞬时故障 → 降级**（Redis 抽风，缓存直查库）。**主动配置的缺失 → fail-fast**（选了 S3 却没配齐，启动就崩）。判据是「这是瞬时网络故障，还是显式的运营决定」。

单次读写失败（S3 网络抖动）则另说：那是瞬时故障，`PostsService.uploadCover` 把它 catch 成 `502 STORAGE_FAILED` 返回给客户端重试，而不是 500 把内部错误吐出来（`src/posts/posts.service.ts`）。

### 7. 封面接进文章：只存「地址」、不存字节；以及孤儿清理

最后把上传结果接进文章。两条铁律：

1. **DB 只存 URL，不存字节**。一张封面几 MB，塞进 PG 的 `meta` 列是反模式（行膨胀、备份爆炸、查询带出无用大字段）。文件在对象存储，DB 里只记它的「地址」。我们的实现把 URL 放进现有的 `meta` JSONB 的 `coverImage` 字段，**零 schema 改动**（`PostMeta` 加了个可选字段，JSONB 本就容纳任意形状）。
2. **改封面不走「更新」主路径**。直接复用 `repo.update` 会 bump `version`、还写一条「内容没变」的修订——封面不是内容修订，混进去会污染修订历史。所以仓储专门加了 `setCoverImage`，只回写 `meta` 这一列，不动 version、不写修订（`src/posts/repositories/posts.repository.ts` + 两份实现）。

`PostsService.uploadCover` 把前面几节串成一条流水线（`src/posts/posts.service.ts`）：

```ts
async uploadCover(id, file, actor) {
  if (!file) throw INVALID_FILE;                       // multipart 没带 file 字段
  const post = await this.loadById(id);                // 404 优先于 403
  this.assertCanModify(post, actor);                   // 作者本人或 admin
  const processed = await this.imageProcessor.processCover(file.buffer);  // §5 核验+归一化
  const key = `covers/${id}/${randomUUID()}.${processed.ext}`;            // §5 uuid key
  const stored = await this.storage.save({ buffer: processed.buffer, key, contentType: processed.contentType });
  const updated = await this.repo.setCoverImage(id, stored.url);          // 只存 URL，不动 version
  await this.invalidate(id);                           // 失效单篇缓存（cover 是文章的一部分）
  if (post.meta?.coverImage) void this.tryDeleteByUrl(post.meta.coverImage); // best-effort 清旧图
  return updated;
}
```

最后那行 **`tryDeleteByUrl`** 解决一个真实且费钱的坑：**孤儿对象**。用户每次换封面，旧图就留在存储里没人引用——天长日久，对象存储里堆满了没用的文件，按存储量计费的话就是直接烧钱。所以换新封面后，把旧封面 best-effort 删掉。注意三点：

- **best-effort**：清理失败（`void` + try/catch + warn 日志）**不影响本次上传**。删旧是「锦上添花」，不能让它把一次成功的上传拖垮。这又是那个「真相源 vs 辅助动作」的区分。
- **异步 fire-and-forget**（`void`）：不 `await`，让响应立刻返回。
- **能反推 key 才删**：删对象需要 key 不是 URL。`StorageService.keyFromPublicUrl` 把对外 URL 反推成存储 key；推不出来（URL 不是本后端发的，比如从别的系统迁来的旧 URL）就跳过。

> 更彻底的防孤儿方案是**后台 GC**：定期扫描存储里所有对象，对照 DB 里引用的 URL，删掉没人引用的。本 demo 只做了「换封面时即时清旧」这一层——它覆盖了最常见的「连续换图」场景，但挡不住「删文章时漏删封面」（我们 `remove` 路径没接封面清理）。

### 8. 两个实打实踩到的坑

本 demo 开发时靠报错才发现，值得单独记——它们都是「配置/工具链」层面的暗坑，文档里一句话带过，真写错时是「明明配了却一动不动」的静默失败。

**坑一：`import multer from 'multer'` / `import sharp from 'sharp'` 类型能过、运行时是 `undefined`**

报错是 `TypeError: (0 , sharp_1.default) is not a function`（multer 同款：`Cannot read properties of undefined (reading 'memoryStorage')`）。

根因在本仓库 `tsconfig.json`：它只开了 `allowSyntheticDefaultImports`（**仅类型层**放行 default import），**没开** `esModuleInterop`（运行时不插 `__importDefault` 包装）。于是 `import X from 'cjs模块'` 编译成 `X = cjs_1.default`，而 multer/sharp 是 `module.exports = 函数`（没有 `.default` 属性）→ 运行时 `undefined`。

那为什么 `import Redis from 'ioredis'` 一直好好的？因为 ioredis 的 `.d.ts` 用的是 `export =`（CommonJS 导出赋值），TS 对这种模块会把 default import 直接当整个 `require()` 结果——而 multer/sharp 的类型用的是 `export default`，就掉进 `.default` 的坑里了。

绕法（见 `cover-upload.interceptor.ts` / `image-processor.service.ts`）：**namespace import 拿到「函数本身」再断言成可调用**：

```ts
import * as multer from 'multer';
const multerFn = multer as unknown as (opts: ...) => ...;   // CJS 下 namespace 就是 require() 的函数
```

为什么不去 `tsconfig` 开 `esModuleInterop: true` 一了百了？因为它会**改变整个仓库所有 default import 的运行时行为**（前面十几天都没开），动它风险大、还可能引入 Day 1–38 的回归。对两三个库局部绕一下，远比全局改编译选项稳妥。**教训：给 CJS 库写 import 前，先认清本仓库的 interop 设置；default import 类型能过 ≠ 运行时能用。**

**坑二：`UPLOAD_MAX_BYTES` 必须放 `test/setup.cjs`，不能放测试的 `before()`**

测试里把上限调到 1 KiB 好让「超限」用例跑得快。最初写在 `upload.e2e.test.ts` 的 `before()` 里 `process.env.UPLOAD_MAX_BYTES ??= '1024'`，结果应用读到的还是默认 5 MiB——超限用例永远不触发，上传的假字节一路走到 sharp 才被拒（422 而非 413）。

根因：**`@nestjs/config` 在「import 阶段」就把 env 烘焙成配置对象**。`before()` 是测试文件 import【之后】才跑的，那时 `storage.upload.maxBytes` 早已定型成默认值，`before()` 里改 `process.env` 为时已晚。这恰恰是本仓库为什么专门有 `test/setup.cjs` 这个预加载文件——它用 `-r` 在一切 import【之前】执行。`setup.cjs` 顶部的注释原话就是讲这个时序坑。

修法：把 `UPLOAD_MAX_BYTES ??= '1024'` 挪进 `setup.cjs`（和 `JWT_ACCESS_TTL`、`GITHUB_*` 同理——都是「测试需要、又必须在 import 前就位」的 env）。这又一次印证了 Day 1 那条哲学：**配置应该在启动第一秒就定型，而不是请求进来/测试开跑才现设。**

### 9. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/storage/storage.service.ts` | **新增**：存储后端抽象（`StorageService`）+ `SaveInput` / `StoredFile` 类型 |
| `src/storage/storage.constants.ts` | **新增**：DI token `STORAGE_SERVICE` + 图片 MIME 白名单（不含 SVG） |
| `src/storage/local-storage.service.ts` | **新增**：本地磁盘后端（默认）。写盘 + `safeAbs` 防目录穿越 |
| `src/storage/s3-storage.service.ts` | **新增**：S3 兼容后端（R2/MinIO/AWS）。PutObject/Delete/Head + 公开 URL 拼接 |
| `src/storage/image-processor.service.ts` | **新增**：Sharp 核验（真图）+ 归一化（缩放/webp/EXIF 旋正） |
| `src/storage/cover-upload.interceptor.ts` | **新增**：配置驱动的 Multer 拦截器。`memoryStorage` + `fileSize` 闸 + MIME `fileFilter` + 错误翻译 |
| `src/storage/storage.module.ts` | **新增**：@Global 模块。按 `STORAGE_BACKEND` 选后端（s3 缺 bucket → fail-fast） |
| `src/posts/posts.service.ts` | 新增 `uploadCover`（核验→处理→存储→落库→清旧）+ `tryDeleteByUrl`；注入存储/处理器 |
| `src/posts/posts.controller.ts` | 新增 `POST /posts/:id/cover`（multipart，需登录 + 作者/admin） |
| `src/posts/repositories/*.ts` | 接口 + Prisma + InMemory 都加 `setCoverImage`（只改 meta，不 bump version） |
| `src/posts/entities/post.entity.ts` + `dto/post-meta.dto.ts` | `PostMeta` 加可选 `coverImage`（响应里带出；宽松校验，不误拒相对 URL） |
| `src/main.ts` | local 后端时挂 `useStaticAssets` 让 `/uploads/...` 可访问 |
| `src/config/{configuration,config.validation}.ts` | 新增 `storage` 配置块：backend / localDir / maxBytes / cover / s3.* |
| `src/common/constants/error-codes.ts` | 新增 `UPLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` / `INVALID_FILE` / `STORAGE_FAILED` |
| `.env.example` | 文档化存储相关环境变量（含 R2/MinIO/AWS 各自填法） |
| `test/setup.cjs` | 加 `UPLOAD_MAX_BYTES=1024`（必须在 import 前就位，见 §8 坑二） |
| `test/upload.e2e.test.ts` | **新增**：正常上传 / 超限 / 非图片 MIME / 伪装字节 / 鉴权 / admin / 旧图清理 / 404 |
| `test/posts.service.unit.test.ts` | mock 仓储补 `setCoverImage`（接口加了方法，mock 得跟上） |

### 10. 一份诚实清单

✅ **今天到位的：**
- multipart 上传落地：`CoverUploadInterceptor` 用 Multer 解析，配置驱动的 `fileSize` / `fileFilter`，错误统一翻译
- 存储后端抽象：`StorageService` + 本地/S3 两实现，换后端只动一行 `useFactory`
- S3 兼容：一个 `S3Client` 打 R2/MinIO/AWS，`forcePathStyle` 区分清楚
- Sharp 纵深防御：体积上限 + MIME 白名单 + 字节级核验（挡改名伪装）+ uuid key（防穿越/覆盖/泄露）+ 鉴权
- 图片归一化：限宽（不放大）+ 转 webp + EXIF 旋正
- DB 只存 URL，封面用专用 `setCoverImage`（不污染 version/修订）
- 旧封面 best-effort 清理（防孤儿）

⚠️/❌ **还没做、明确知道的缺口：**
- **删文章没清封面**：`remove` 路径没接 `tryDeleteByUrl`，删文章会留孤儿封面；生产该补后台 GC 扫描全量对象对账
- **S3 没接 presigned URL 直传**：现在是服务端中转上传（客户端→API→S3），大文件白跑一趟 API、占带宽；生产应给客户端发预签名 URL，让它**直传 S3**，API 只收「上传完成」的回调
- **没做缩略图/多尺寸**：只生成一档（最大宽 1600）；真实场景要 cover + thumb + og-image 多档，按设备分发
- **没限速 / 没配额**：单用户单位时间上传次数没限制，可被滥用刷存储；该叠 Day 35 的 `@Throttle` 或单独的上传配额
- **病毒扫描没做**：图片核验挡得住「不是图」，挡不住「是图但藏了恶意元数据/隐写」；高安全场景要接 ClamAV 之类
- **S3 单次失败无重试**：`save` 抛错直接 502，没做指数退避重试（瞬时故障靠客户端重试）；和 Day 38 的队列重试是两套，没复用
- **`meta` JSONB 放 coverImage 是简化**：真实 schema 该有独立的 `cover_image` 列或 `media` 表（支持多图、版本、尺寸元信息）。放 meta 是为了今天零 schema 改动
- **本地后端不适合生产**：只单实例可见，没多副本共享、没 CDN、磁盘会满——它的定位就是「开发/测试的零配置默认」

---

## 💻 实践练习

1. **走一次完整上传**：起服务、登录拿 token、建一篇文章，然后
   ```bash
   curl -F 'file=@./cover.png' -H "Authorization: Bearer <token>" \
        http://localhost:3000/posts/<id>/cover
   ```
   看响应里 `data.meta.coverImage` 是 `/uploads/covers/<id>/<uuid>.webp`。浏览器开 `http://localhost:3000/uploads/covers/<id>/<uuid>.webp` 应能直接看到图（`main.ts` 挂的 static）。`ls uploads/covers/<id>/` 亲眼看文件落盘了。
2. **触发四类拒绝**：分别上传 (a) 一个 >5 MiB 的文件 → 413 `UPLOAD_TOO_LARGE`；(b) 一个 `.pdf` → 415 `UNSUPPORTED_MEDIA_TYPE`；(c) 一个把 `text.txt` 改名 `x.png` 上传 → 422 `INVALID_FILE`（Sharp 看穿了）；(d) 不带 token → 401；(e) 用别人的 token → 403。理解每条命中的是 §5 清单里的哪一层。
3. **切到 MinIO（本地 S3）**：`docker run -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"`，建个 bucket，在 `.env` 设 `STORAGE_BACKEND=s3`、`S3_ENDPOINT=http://localhost:9000`、`S3_FORCE_PATH_STYLE=true`、`S3_BUCKET=...` + access/secret。重启后再上传——**业务代码一行没改**，只是 `useFactory` 选了 `S3StorageService`。这就是抽象的意义。
4. **验证孤儿清理**：对同一篇文章连传两张图，看 `uploads/covers/<id>/` 下只剩最新那个（旧的被 `tryDeleteByUrl` 删了）。日志里若清理失败会有 warn。
5. **思考题**：如果用户在「上传成功、Sharp 处理完、S3 写入完成，但还没来得及 `setCoverImage` 更新 DB」之间进程被 `kill -9`，会发生什么？文件已经在 S3 了，但 DB 里的 `coverImage` 还是旧的——这个文件成了**孤儿**，没人引用也删不掉。我们今天没有任何机制能把它收回来。怎么治？（提示：要么「先记 DB 占位（pending）→ 再传 S3 → 成功后置 confirmed / 失败回滚清理」，要么靠后台 GC 定期对账。这和 Day 38 的「at-least-once + 幂等」是同一类「最终一致性 + 兜底回收」问题。）
6. **思考题二**：为什么 `STORAGE_BACKEND=s3` 缺 bucket 时要启动即崩，而 Redis 连不上只是降级？把 §6 那句判据（「瞬时故障降级 vs 显式配置缺失 fail-fast」）用自己的例子再讲一遍——比如「数据库连不上」应该走哪一种？（答：fail-fast——DB 是真相源，没有降级路径，Day 27 的 `PrismaService` 启动即 `$connect()` 就是这个意思。）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（multipart/Multer / 存储后端抽象 / S3 兼容 / Sharp 纵深防御 / 降级 vs fail-fast）
- [ ] 跑通 `upload.e2e.test.ts`，亲手 `curl -F` 上传一张图并浏览器打开返回的 URL
- [ ] 切到 MinIO 验证「换后端业务零改动」，体会防腐层抽象
- [ ] 在笔记里写下「我的项目里哪些上传该用服务端中转、哪些该 presigned 直传、孤儿对象怎么治」

---

[⬅️ Day 38](../day-38/) | [➡️ Day 40](../day-40/)
