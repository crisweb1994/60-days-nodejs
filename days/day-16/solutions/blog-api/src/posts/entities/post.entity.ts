// Post 实体：当前 Day 用内存存储，结构与后续接入数据库时保持一致
export class Post {
  id!: number;
  title!: string;
  content!: string;
  author!: string;
  tags!: string[];
  published!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
