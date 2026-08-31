# LLMWiki 生产一键部署

本目录提供局域网生产部署方案。生产环境只会初始化一个超级管理员账号 `admin` 和内置角色，不会创建演示用户、组织、知识库或文档。

## 新机器安装

要求：Docker Engine、Docker Compose v2、至少 8GB 内存；如果需要解析复杂 PDF/DOCX，建议 16GB 以上内存。

在项目根目录执行：

```bash
./deploy/install.sh
```

安装脚本会：

1. 生成 `.env` 和服务端随机密钥；
2. 交互式设置 `admin` 初始密码；
3. 构建 API、Web、Parser 和 GBrain 镜像；
4. 启动 PostgreSQL/pgvector、Redis、MinIO 和 Parser；
5. 执行 Prisma 生产迁移；
6. 幂等创建 `admin` 和内置角色；
7. 启动 API、Web 和 Nginx；
8. 执行健康检查并输出局域网访问地址。

也可以用于无人值守安装，但初始密码应通过受保护的环境变量传入，不要写入脚本或 Git：

```bash
ADMIN_INITIAL_PASSWORD='至少12位的临时密码' ./deploy/install.sh
```

首次登录必须修改密码。初始密码实际保存于 `.secrets/admin_initial_password`，该目录已加入 `.gitignore`。

## 升级

保留 PostgreSQL、MinIO、Redis、上传原件、GBrain source 和管理员密码，仅重新构建镜像、执行迁移并滚动启动服务：

```bash
./deploy/upgrade.sh
```

## 访问

默认通过 Nginx 暴露 `HTTP_PORT`，默认为 `20080`。生产端口要求为 `20000-65535`，不使用 80、8080、443、8443：

```text
http://服务器局域网IP:20080/
```

如需使用其他高位端口，修改根目录 `.env` 中的 `HTTP_PORT` 后执行 `./deploy/upgrade.sh`。访问地址改变时，同时将 `WEB_ORIGIN` 改为实际的协议、主机和端口。

数据库、Redis、MinIO、Parser 和 API 不映射到宿主机端口，仅在 Compose 内部网络通信。若接入 HTTPS，可在 Nginx 前增加局域网证书网关，或扩展 `deploy/docker/nginx.prod.conf`。

## 重要生产注意事项

- 不要执行 `packages/database/prisma/seed-full.ts` 或开发用 `seed.ts`。
- 不要把 `.env`、`.secrets/`、模型 API Key 或上传文件提交到仓库。
- 模型供应商和模型配置在登录后通过管理界面添加，密钥在数据库中加密保存。
- 首次上线前应备份 PostgreSQL、MinIO 和 `brain_data` 卷。
- `install.sh` 不会删除既有数据；重装或卸载时也不要在未确认备份前使用 `docker compose down -v`。

## 常用运维命令

```bash
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f api
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f parser
deploy/healthcheck.sh
```
