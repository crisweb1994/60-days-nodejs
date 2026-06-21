// 存储层抽象。和 PostsRepository 一个思路：业务只依赖这个抽象类（DI token STORAGE_SERVICE），
// 不关心字节最终落在本地磁盘还是 S3 / R2 / MinIO。换后端只动 StorageModule 的 useClass。
//
// 它和 RedisService 的哲学一致——存储是「真相源之外的一层」：
//   - 默认本地磁盘，零配置可用（测试、本地开发都不依赖外部对象存储）；
//   - S3 是「显式选配」的后端（STORAGE_BACKEND=s3），连不上应在启动时 fail-fast，
//     而不是像 Redis 那样静默降级——因为选 S3 是运营决定，配错就该立刻炸出来。
//     单次读写失败则抛回调用方，由 PostsService 翻译成 STORAGE_FAILED。

/** save 的入参：字节 + 「我们自己生成的」key + 内容类型。 */
export interface SaveInput {
  buffer: Buffer;
  key: string;
  contentType: string;
}

/** save 的产出：key + 对外可访问的 URL + 体积 + 内容类型。 */
export interface StoredFile {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

/**
 * 存储后端抽象。两个实现：LocalStorageService（默认）、S3StorageService（可选）。
 * 实现 STORAGE_SERVICE 这个 token，业务统一注入。
 */
export abstract class StorageService {
  /** 后端标识，日志 / 健康检查里区分。 */
  abstract readonly backend: 'local' | 's3';

  /** 这一层是否「看起来」可用。local 恒 true；s3 = 凭证齐全（真正可达性在每次操作里检验）。 */
  abstract readonly available: boolean;

  /** 把字节写到 key，返回对外 URL。 */
  abstract save(input: SaveInput): Promise<StoredFile>;

  /** 删除 key。best-effort：调用方对失败应容错（如孤儿清理）。 */
  abstract delete(key: string): Promise<void>;

  /** key 是否已存在。 */
  abstract exists(key: string): Promise<boolean>;

  /** 由 key 拼出对外 URL。 */
  abstract publicUrl(key: string): string;

  /**
   * 由对外 URL 反推 key——封面更新时删旧图用（避免孤儿对象长期占存储 / 烧钱）。
   * 推不出来（URL 不是本后端发的）返回 null，调用方据此跳过清理。
   */
  abstract keyFromPublicUrl(url: string): string | null;
}
