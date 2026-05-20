export type PostStatus = 'draft' | 'published' | 'archived';

export const POST_STATUSES: PostStatus[] = ['draft', 'published', 'archived'];

export interface PostMeta {
  seoTitle: string;
  seoDescription: string;
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
  createdAt: Date;
  updatedAt: Date;
}
