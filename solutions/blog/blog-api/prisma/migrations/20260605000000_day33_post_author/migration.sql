-- Day 33：给 posts 加 author（资源级权限的 owner）。可空，删用户时置空（SET NULL）。

-- AlterTable
ALTER TABLE "posts" ADD COLUMN "author_id" UUID;

-- CreateIndex
CREATE INDEX "posts_author_id_idx" ON "posts"("author_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
