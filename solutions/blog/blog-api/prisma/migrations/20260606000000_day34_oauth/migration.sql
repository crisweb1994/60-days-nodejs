-- Day 34：OAuth。password 改可空（纯第三方登录的用户没有密码）；users 加 github_id 绑定 GitHub。

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL,
                    ADD COLUMN     "github_id" VARCHAR(32);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");
