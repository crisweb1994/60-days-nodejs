export type PostStatus = 'draft' | 'published' | 'archived';

export interface PostMeta {
  seoTitle: string;
  seoDescription: string;
}

export interface Post {
  id: number;
  title: string;
  slug: string;
  content: string;
  tags: string[];
  status: PostStatus;
  meta?: PostMeta;
  createdAt: Date;
  updatedAt: Date;
}
