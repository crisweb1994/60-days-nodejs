# Docker 速查手册

## 基本概念

```
镜像（Image）    → 只读模板，类似于类
容器（Container）→ 镜像的运行实例，类似于对象
Dockerfile      → 构建镜像的脚本
Docker Compose  → 多容器编排工具
```

## Dockerfile

```dockerfile
# 多阶段构建
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Docker 命令

```bash
# 镜像
docker build -t my-app .              # 构建镜像
docker images                         # 列出镜像
docker rmi my-app                     # 删除镜像

# 容器
docker run -d -p 3000:3000 my-app     # 运行容器
docker run --rm -it my-app sh         # 交互式运行
docker ps                             # 列出运行中的容器
docker ps -a                          # 列出所有容器
docker logs <container-id>            # 查看日志
docker logs -f <container-id>         # 实时日志
docker stop <container-id>            # 停止容器
docker rm <container-id>              # 删除容器
docker exec -it <container-id> sh     # 进入容器

# 清理
docker system prune                   # 清理无用资源
docker volume prune                   # 清理无用卷
```

## Docker Compose

```yaml
# docker-compose.yml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db:5432/mydb
      - REDIS_URL=redis://redis:6379
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: mydb
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

## Docker Compose 命令

```bash
docker compose up -d          # 启动服务（后台）
docker compose down           # 停止并删除
docker compose logs -f app    # 查看日志
docker compose exec app sh    # 进入容器
docker compose build          # 重新构建
docker compose ps             # 查看状态
```

## .dockerignore

```
node_modules
dist
.git
.env
*.md
.vscode
```

## 最佳实践

1. 使用 **alpine** 基础镜像（更小）
2. 使用**多阶段构建**（减小最终镜像）
3. **非 root 用户**运行（安全）
4. 合理使用**缓存层**（先 COPY package.json，再 COPY 代码）
5. 使用 `.dockerignore` 排除不必要的文件
6. 使用 **healthcheck** 确保服务就绪
