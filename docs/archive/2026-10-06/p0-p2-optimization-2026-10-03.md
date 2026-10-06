# P0-P2 优化落地与待外项说明（2026-10-03）

对应 `docs/plans/sota-optimization-output-2026-10-03.md` 的 P0/P1/P2 三级清单。
本文记录：已落地项与验证方式；以及两类**无法在本地编码会话内完成**的事项及其执行协议。

## 一、需外部资源的事项（书面结论）

### 1. P2-4 容量验证（10 万块/20 并发、100 万块/50 并发、10 实例混合负载）

本地测试环境（单实例、PG 5433、语料 1.1 万文档）不具备该量级的算力与语料。
执行协议（需在独立压测环境跑）：

- 语料构造：用 `tests/evaluation/scale/` 的生成器扩到 10 万/100 万 chunk（保持发布态、含 ACL 混合）。
- 负载：k6 或 vegeta，20/50 并发，问题集从 golden 集采样（每桶 ≥50），P95 延迟与失败率采样。
- ANN 对照：pgvector HNSW 在可见比例 100%/10%/1% 下与精确搜索对比 Recall@10（分桶报告）。
- 10 实例混合负载：`scripts/provision-instance.sh` 扩到 10 实例，验证 Redis DB 隔离（实例 N ↔ DB N-1）与共享 PG 的连接池上限。
- 通过标准：P95 ≤ 计划第五节预算（首字 ≤3s、全答 ≤10s）且失败率 <0.5%、无跨实例任务抢占。

### 2. P1 质量-4 评测扩容（golden 50 → 1000+，每桶 ≥50）与人工盲评

题库内容编纂与人工评审是内容工作，不能由代码会话替代：
- 扩容协议：按 11 个查询桶从冻结语料派生题目（题目-证据对必须人工或半自动校验），
  复用 `shard_golden.py` 分片、`run-evaluation.ts` 执行、`core-flow/paired_gate.py` 门禁
  （要求 runId/gitCommit/corpusHash/policyVersion 全套溯源，min_cases=1000, min_bucket=50）。
- LLM judge：`quality-gate.ts` 已内置多采样 judge + spread 报告（JUDGE_SAMPLES），
  `ci-gate.sh` + `gate-thresholds.sh` 已是发布门禁；扩容后 GATE_STRICT=1 全量跑。
- 每月人工盲评：运营流程，建议抽样 ≥100 题/月，双人独立标注一致率 ≥0.8。

### 3. P2-5 Web lint 存量（115 errors）——按计划单独开 PR

现状（2026-10-03 复测）：115 errors / 145 warnings，其中：
- ~90 处 `@typescript-eslint/no-explicit-any`（集中在 AdminScreen/OrgPanel/SystemStatusPanel/LibrariesScreen 等管理屏）
- ~25 处 React Compiler 新规则（`react-hooks/set-state-in-effect`、refs-during-render、memoization 保留失败）
这些是行为敏感的结构性重构（数据加载 effect 改造、DTO 定型），按原计划**单独 PR** 处理，
不与本次 P0-P2 行为变更混发布。本次会话未新增任何 lint 错误（触及文件均为净零）。

## 二、faithfulness 诊断流程（P1 质量-1）

```bash
LLMWIKI_TOKEN=<jwt> npx tsx tests/evaluation/faithfulness-diagnose.ts --bucket exact_clause --limit 40
```
输出 JSONL（每题三段：检索 trace / 证据包 / 答案+句级绑定）与归因汇总
（retrieval_empty / evidence_weak / no_markers / ungrounded_sentences / keyword_miss / 拒答类）。
改生成链路之前先跑诊断定位问题环节；faithfulness/keyword 同低时先查评测口径。

## 三、已落地项与验证结论（2026-10-03 测试环境）

### 单元/集成测试
- API 全量 jest：992+ passed / 0 failed（含本次新增 25+ 用例：增量流式分块 15、语义缓存向量命中 8、
  图谱路由 4、单元格坐标 2、B-6 引用角标 4、B-2 权限矩阵 4、B-9 死信/重放 5、B-11 元数据合并 1 等）
- tsc --noEmit 干净；改动文件 eslint 零告警；Web 测试 52/52。

### 端到端（本机 3202 实例，systemd --user 服务）
- P0 套件（tests/e2e/verify_p0_fixes_e2e.py）：23/23 全绿（B-2/B-6/B-8/B-9/B-11/xlsx）。
- P1/P2 套件（tests/e2e/verify_p1_p2_e2e.py）：硬断言 11/11 全绿（B-3 载荷、R-3 分页、B-1 SSE 契约、
  阶段事件、P2-3 图谱路由）；2 项软断言带诊断结论：
  1. 增量 delta 多块：strict 落地门持句时按设计缓冲（质量优先）；已验证前缀流式由单测 15/15 覆盖，
     阶段事件（retrieving→reranking→generating→verifying）实测全部到达。
  2. B-5 缓存命中：CACHE_MIN_GROUNDING=0.8 门槛按设计拒绝低 grounding 答案入库（实测连逐字引用
     问题也因中文引导句 coverage<0.8 被拒）。这是 faithfulness 主线的已知问题（见计划 P1 质量-1），
     向量命中逻辑本身由单测 8/8 覆盖；grounding 修复后缓存自然启用。

### 过程中发现并修复的存量缺陷
- admin 变更端点在请求上下文内 await dispatchPending 触发身份提升拒绝（HTTP 500）：新增
  runOutsideRequestContext + kickDispatch（5 处调用点），并补「请求上下文内踢发不抛异常」回归测试。
