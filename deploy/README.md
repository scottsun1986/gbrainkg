# LLMWiki 生产环境部署 (宿主机原生架构 / Host-Native)

生产环境采用与测试环境一致的**宿主机原生部署模式（Host-Native via Systemd）**，直接运行在 Linux 宿主机上，无需通过 Docker Compose 封装应用容器，提供极佳的性能、直观的日志与便捷的运维体验。

## 架构说明

- **Web 前端 (`llmwiki-web.service`)**: Next.js 生产包，监听端口 `3200`（绑定 `0.0.0.0:3200`，局域网与本机均可访问）。
- **API 后端 (`llmwiki-api.service`)**: NestJS 生产包，监听端口 `3202`（`0.0.0.0:3202`），内置 GBrain 知识引擎与混合检索通道。
- **解析服务 (`llmwiki-parser.service`)**: FastAPI / Uvicorn Python 微服务，监听端口 `8100` (`127.0.0.1:8100`)。
- **存储与缓存**:
  - PostgreSQL (带 `pgvector` 扩展，监听端口 `5433` 或 `5432`)
  - Redis (监听端口 `6379`)
  - 文档上传路径: `~/.local/share/llmwiki/uploads`
  - GBrain 知识库数据: `~/.local/share/llmwiki/brain_repos`

---

## 快速安装与部署

### 1. 环境依赖

- **Node.js**: >= 18 (推荐 Node 20 LTS)
- **pnpm**: >= 9.0
- **Python**: >= 3.10 (含 FastAPI, Uvicorn, PyPDF 等依赖)
- **PostgreSQL**: 16+ (带 pgvector 扩展)
- **Redis**: 7+

### 2. 执行一键安装

在项目根目录执行：

```bash
./deploy/install.sh
```

一键安装脚本自动完成以下步骤：
1. 检查宿主机环境依赖（Node、pnpm、Python3、curl 等）；
2. 自动准备 `apps/api/.env` 与 `apps/web/.env.production`，生成强随机密钥；
3. 安装 monorepo Node 依赖 (`pnpm install`)；
4. 执行 Prisma 客户端生成与数据库迁移 (`prisma migrate deploy`)；
5. 编译构建 API 后端与 Web 前端；
6. 自动注册并启用 Systemd 用户服务 (`~/.config/systemd/user/llmwiki-*.service`)；
7. 开启用户会话守护 (`loginctl enable-linger $USER`)，确保终端登出后服务持续运行；
8. 执行健康检查并输出局域网访问地址。

---

## 生产升级维护

代码更新后，仅需在根目录下执行一键升级：

```bash
./deploy/upgrade.sh
```

升级脚本会自动完成依赖更新、数据库迁移、重新构建 API 与 Web 前端、平滑重启 systemd 用户服务并执行健康检查。

---

## 访问与验证

- **Web 管理界面**: `http://<服务器局域网IP>:3200` 或 `http://localhost:3200`
- **API 接口地址**: `http://<服务器局域网IP>:3202` 或 `http://localhost:3202`
- **初始管理员账号**: `admin`

---

## 常用运维命令 (Systemd)

所有的应用进程均通过 `systemd --user` 进行生命周期管理：

```bash
# 查看服务运行状态
systemctl --user status llmwiki-web.service llmwiki-api.service llmwiki-parser.service

# 重启全部服务
systemctl --user restart llmwiki-parser.service llmwiki-api.service llmwiki-web.service

# 停止服务
systemctl --user stop llmwiki-web.service llmwiki-api.service llmwiki-parser.service

# 查看实时日志
journalctl --user -u llmwiki-web -f
journalctl --user -u llmwiki-api -f
journalctl --user -u llmwiki-parser -f

# 执行健康检查
./deploy/healthcheck.sh
```
