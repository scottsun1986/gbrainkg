# SOTA 优化轮次测试结果

日期：2026-10-07。最终构建、测试和数据库/Redis集成由 `gpt-6-luna` 在本地测试环境执行；SOTA20只使用测试API和唯一前缀隔离的临时知识库，未访问生产。详细原始日志位于 `docs/validation/2026-10-07/optimization/`。

## 通过

- API 构建通过；最终稳定源码定向测试 3 suites、25 tests 全通过，覆盖校准routeHash、拒答证据门槛、来源同步501文档与空来源清理（`batch7-*`）。
- Chat prompt、ChatService、拒答、完整扫描、社区召回、Redis、权限缓存相关测试均在完整API运行中通过。
- O3真实worker `SIGKILL`、Redis任务丢失、持久outbox补投、不可变版本仅发布一次及启动/周期parser恢复通过（`batch8-service-loss.log`）。
- O7编译数据库集成：6 Source、21,001 chunks、真实 truth diff、pgvector主题导航、并发snapshot与社区manifest通过（`batch5-compiler.log`）。
- O13规模与应用边界：2,232 artifacts、908 sources、2,026,656依赖行；可读、ACL拒绝、hash漂移、过期来源、manifest缺失、匿名访问、库撤权及模型共享配额均符合预期；隔离数据清理通过（`batch8-artifact-quota.log`）。核心查询耗时约8–9秒，证明规模正确性与授权语义，不证明性能目标达成。
- O6当前测试库只读ANN对照：5,206个已发布向量、100条真实库内查询、三个过滤桶；ANN Recall@10均值/最小值均为1.0，但查询向量来自该语料且仅59/100计划使用HNSW，其余为精确回退。因此实际ANN门禁失败，不能据此宣称ANN质量达标（`ann-current-test-corpus.json`）。
- 本轮新增专项、校准/配对IR/ArguAna扩展的selftest，以及Redis本地断连恢复测试见相邻batch日志；O10证据只覆盖测试到的DB频道和本地重连情景。

## 完整套件状态

Luna受限sandbox中的首次 `pnpm run test:all` 退出码1，停在API阶段。API Jest：160 suites passed、1 skipped、2 failed；1,376 tests passed、5 skipped、3 failed。失败定位为 `auth/user-credential.spec.ts` 无法连接本地 `localhost:5433` 测试数据库，以及 `startup-port.spec.ts` 在Luna受限运行环境监听 `0.0.0.0` 收到 `EPERM`。Jest另报告worker强制退出。随后在工作区常规测试环境完全相同命令 `pnpm run test:all` 退出0：API **162 suites passed、1 skipped；1,379 tests passed、5 skipped、0 failed**，parser **54 tests+4 subtests passed**，adapter **17/17 passed**。额外全API `jest --runInBand`自然退出0，未报告open handle/worker强退。故O14自然退出门禁通过；sandbox失败保留作为环境受限记录。

首次Luna sandbox全量日志：`final-test-all.log`、`final-test-all.exit`。parser/adapter单项sandbox尝试分别停滞及子进程合同失败，工作区常规环境的最终完整suite日志：`final-test-all-direct.log`、`final-test-all-direct.exit`；额外全API自然退出结果：`final-api-direct.log`、`final-api-direct.exit`。工作区常规最终通过结果为验收依据；受限sandbox失败仅记录运行环境限制。

## 校准与基准口径

### SOTA20 当前源码全查询重测

Luna在已重启的测试API上，对20个现有评测库执行只读重测；20/20库与本地评测输入精确匹配，均成功。每个本地corpus文件为100条记录，运行器未截断这些文件，并遍历本地全部queries/qrels；这里的“full-corpus”仅指完整使用当前100条记录的本地评测文件，**不代表上游公开语料的全量规模**。宏平均 nDCG@10=0.826524、MRR@10=0.869546、Recall@10=0.847904；各数据集结果见[原始报告](validation/2026-10-07/optimization/sota20-full-current-luna/report.json)，运行日志与退出码见 `batch15-sota20-full.log`、`batch15-sota20-full.exit`（0）。

该结果使用当前测试服务、配置和run，不能与既有历史报告直接视为同条件配对；它也没有完整上游语料或独立答案质量裁决。因此它证明这20个本地数据集/全查询运行成功并提供当前IR基线，不证明O4的配对收益、O12 leaderboard等价或完整RAG质量。唯一前缀采样库已核实为0个遗留。

实际测试reranker的800条观察分数（40个查询组、40个正相关）保留为诊断数据。查询组互斥拆分为560训练/240留出；在公开ArguAna qrels的闭世界相关性口径下，拒答precision 0.958（238个判定）、recall 1.0（228个正例），Brier 0.0333；只接受2个回答，answer precision 1.0、recall 0.167。qrels相关不等于事实蕴含或查询可回答性，样本也不足以据此部署阈值。缺少不可变reranker部署revision，默认校准明确拒绝写profile；诊断模式不激活任何profile。证据：`rerank-holdout-diagnostic.json`、`batch8-rerank-default.log`、`batch8-rerank-diagnostic.log`。

完整RAG与独立多跳裁决、同配置配对质量对照与置信区间、当前语料ANN≥0.98、sample/full社区质量成本对照、浏览器会话复用，以及生产部署并发下的验证仍未通过；生产环境未变更。
