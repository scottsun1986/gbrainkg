# v54.0 — 架构审查实施与计量/图谱/预览大版本

本版本落实 2026-10-07 架构代码审查（[审查原文](ARCHITECTURE-CODE-REVIEW-2026-10-07.md)）的
实施项与验收记录（[实施与验收记录](ARCHITECTURE-CODE-REVIEW-2026-10-07-IMPLEMENTATION.md)），
覆盖 **F01–F10 授权与检索/引擎/计量/图谱/预览** 全链路改造，并在功能实测中修复一处
**权限可见性缓存失效缺口**。

## 主要变更

### 1. 关键修复（功能实测发现）
- **新建/归档个人知识库后立即失效属主权限缓存**（`knowledge-base.controller.ts`）。
  此前 `PERMISSION_CACHE_TTL_MS`（默认 5s）内的可见库缓存不含新库，导致创建后**立即**
  上传/入库/列库 403，约 5s 后自愈。现创建与归档均调用
  `permissionService.invalidatePermissionCaches(userId)`（含多副本 Redis 广播），
  并新增 2 条回归用例。

### 2. F01–F10 审查实施
- **F01 聚合授权**：inventory 在文本构造前批量 ACL/时效过滤；聚合强制精确
  `sourceDocumentIds`；restricted 空 ACL 与 `DocumentAclService` 一致裁决。
- **F02 热缓存 / F03 惰性回填**：子查询缓存复用统一 `fallbackChunkToCitation` 转换；
  编译成功后按可达条件回填，以实际新增条数决定 trace。
- **F04 派生 guard / F09 历史依赖**：`evidenceContext` 保留 scope/sourceKeys/ACL 与
  知识 epoch；capture 追踪原文与全部聚合来源，混合任一缺失 manifest 即拒绝；
  `inventory` 为显式对象并与 KB 绑定。
- **F05 引擎策略**：chat/agent 统一 `chunks_only` 禁用引擎臂；空候选引擎结果不挤掉
  DB 分支；可用性按真实引用判断。实测 trace 出现 `gbrain_arm_policy skipped`。
- **F06 Top-K 前授权**：`readable-document-scope.ts` 将 ACL/owner/admin/组织/时效
  谓词编译进 dense、BM25/lexical、结构、图谱及浏览列表的 **LIMIT 之前**。
- **F07 能力闭环**：`CORE_VERSIONING_ENABLED` 与 BGE sparse/maxSim 组合在启动时报错，
  拒绝未构建索引；实测两种变体均启动失败（退出码 1）。
- **F08 资源截止**：检索臂统一预算登记，SQL/ORM 设置服务端 `statement_timeout`，
  权限预算独立，撤权/取消不吞为普通无结果。
- **F10 预览传输**：`document-preview-transport` 方法级接受签名 token，绑定
  user/KB/doc/version/expiry；其他入口保持登录认证。

### 3. 节点/图谱质量与提示词
- QueryExecution 以稳定 evidence ID 记录各臂启动/跳过/候选/授权/重排/上下文 tokens/
  最终引用/耗时；RAPTOR 全局摘要解析至精确文档与当前原文 Chunk。
- 新增只读 `apps/api/scripts/graph-quality-audit.ts`（显式 KB、只读事务、SQL timeout）。
- 主回答数据/指令分层；语言路由、前缀缓存、句级核验策略审计（见实施记录 §5.2）。

### 4. 计量闭环（§6.3）
- SSE `done.pipeline_timing` 与历史 `processingTrace[id=pipeline_timing]`；
  `GET /chat/runs/:runId` 返回 `timing.runReadyMs/pollServedMs`；
  `POST /chat/messages/:messageId/render-timing` 由浏览器在答案可见渲染后
  （双 rAF + IntersectionObserver）经 owner 约束 ACK 写入 `client_render_timing`。

### 5. 评测工具
- 新增配对消融工具 `tests/evaluation/intl-benchmark/ablation_eval.py` 与 `ABLATION.md`，
  复用 official-qrels IR 与配对 bootstrap；默认只读已采集实验，不改动/部署服务。

## 验证

- **API 单测**：168 套件 **1462 项通过**（5 skipped）；`nest build` / `tsc --noEmit` 通过。
- **Web 单测**：**76/76 通过**。
- **SOTA 知识库 E2E（P0–P8）**：**25/25 通过**（P7 图谱首建 10.1s / 缓存 0.06s；
  P8 问答 P50≈42s）。
- **全范围功能套件（A–H）**：修复后 **70/71**；唯一失败 `KB-004` 为"超长库名静默截断为
  120 字符"的产品语义选择（非崩溃/越权），待产品策略确认。
- **F10 预览 token 矩阵**：12/12（签名放行；篡改/过期/版本不符/停用用户/未知用户/KB 不符
  均 401；其他入口仍需登录）。
- **真实浏览器 E2E**：登录→选范围→提问→答案渲染→`client_render_timing` 落库
  （`method=visible-double-raf`, `clock=client-performance`）。
- **F07 能力闭环**：不支持配置启动失败（两种变体）。
- **图谱质量审计脚本**：测试库只读执行返回规范报告（该库无图实体，仅冒烟）。

## 说明

- 本版本提交 GitHub 源码与说明；演示环境与生产环境按发布流程分别执行，
  生产保留发布前快照与回滚点。
- 未实测项见实施记录：OnlyOffice 服务端抓取、多主体完整端到端矩阵、ANN/SQL explain 与
  故障后资源回收、大规模编译/图浏览、完整公开协议与私有集消融、真实费用/延迟。
- 上一版本（语料无关与去业务硬编码）见 [RELEASE-v53.0.md](RELEASE-v53.0.md)。
