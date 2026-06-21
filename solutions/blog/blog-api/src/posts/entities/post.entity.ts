export type PostStatus = 'draft' | 'published' | 'archived';

export const POST_STATUSES: PostStatus[] = ['draft', 'published', 'archived'];

export interface PostMeta {
  seoTitle: string;
  seoDescription: string;
  // Day 39：封面图对外 URL（由 POST /posts/:id/cover 落地，不参与 SEO meta 的 DTO 必填校验）。
  coverImage?: string;
}

export interface Post {
  // 用 UUID 而不是自增 number：迁移到 PostgreSQL / 分库分表 / 分布式生成都无痛
  // 自增 ID 在测试隔离、ID 暴露、跨表关联上代价比 UUID 大
  id: string;
  title: string;
  slug: string;
  content: string;
  tags: string[];
  status: PostStatus;
  meta?: PostMeta;
  // Day 33：作者 id（资源级权限的 owner）。老文章可能为 null（无主）。
  authorId?: string;
  // Day 29：乐观锁版本号，每次成功 update 自增 1
  version: number;
  // Day 29：浏览计数，原子自增
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Day 29：文章修订快照。每次 update 在事务里写一条。
export interface PostRevision {
  id: string;
  postId: string;
  version: number;
  title: string;
  content: string;
  createdAt: Date;
}

// 仓储写入时不接受这些字段：id/时间戳由 DB 生成，version/viewCount 由专门路径维护
export type PostWriteData = Omit<
  Post,
  'id' | 'createdAt' | 'updatedAt' | 'version' | 'viewCount'
>;
