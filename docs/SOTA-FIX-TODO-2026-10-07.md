# SOTA 修复与优化 TODO

日期：2026-10-07；关联 [实施审计](SOTA-IMPLEMENTATION-AUDIT-2026-10-07.md)、[本轮测试结果](SOTA-OPTIMIZATION-TEST-RESULTS-2026-10-07.md) 与 [优化实证](SOTA-OPTIMIZATION-COMPLETION-2026-10-07.md)。勾选仅表示具体缺陷修复已由 Luna 验证，不表示同号原始SOTA差距全部达成。

## 本轮缺陷（修复并通过 Luna 对应验证）

- [x] B1 严格输出移除旧RLS授权函数：同一事务应用ACL/精确来源核验，真实有效输出及撤权共享锁验证；fixture补manifest。涉及原权限体系/反幻觉。
- [x] B2 Redis pub/sub 按 REDIS_DB 隔离频道，消除订阅ack回调竞态和并发连接重复创建。对应原#10。
- [x] B3 权限缓存失效淘汰在途旧读，阻止撤权后旧结果回填；事务授权读取绕过缓存。对应原#10。
- [x] B4 去掉法条排名开关与章条特化bonus/排序；通用结构召回，保留中英/API证据与层级metadata。对应原#4。
- [x] B5 Graph预算贯通摄入/增量/重建，修正默认50残留、full覆盖旧采样/上限配置、artifact identity纳入预算。对应原#8。
- [x] B6 0<预算<1 不再截断为0：scope chunk/source、确定性scan与graph预算使用有限正整数边界。对应原#7/#8/#9。
- [x] B7 登录白名单严格匹配登录路由，嵌套/URL查询文本不绕过其他路由。对应原#11。
- [x] B8 IR零提交coverage显式为0；空排名计失败，__evaluated说明限定提交样本。对应原#12口径。
- [x] B9 集成运行器适配应用层唯一鉴权：撤掉不适用的当前RLS断言，新增当前权限/来源合取真实数据库回归；历史SQL保留且限制用途。
- [x] B10 增量图谱撤回/更新时完整替换依赖和manifest计数，修复旧app_is_service GUC失效造成历史来源累积；来源版本栅栏与库事务锁保留。

逐项勾选证据如下，执行模型均为 `gpt-6-luna`，详细命令与退出码见 [测试结果](TEST-RESULTS-2026-10-07.md)。API 最终离线单测为 156 passed 套件、1354 passed/5 skipped；6 个专项 spec 为33/33；当前四个隔离数据库集成脚本均通过。最后 graph 补丁另外由同一集成运行器构建并重新验证。

| 项 | 对应验证 | 产物 |
|---|---|---|
| B1 | strict-output-permit 专项；versions 中缺失/hash漂移拒绝、有效manifest允许、撤权提交与输出共享锁串行；应用权限矩阵 | `focused-regressions-final.log`、`integration-core-final.log` |
| B2 | Redis DB频道隔离、ack前消息接收、并发单订阅连接三项专项 | `focused-regressions-final.log` |
| B3 | role/visible-library 在途失效重算与显式事务绕过管理员缓存 | `focused-regressions-final.log` |
| B4 | 实际 fallback fusion 中中文章名/English chapter/API标题不颠倒实测通道排名、证据和metadata保留；corpus policy/config | `focused-regressions-final.log`、`test-all-final.log` |
| B5 | 图谱预算/full覆盖配置单测、真实增量graph分片复用/撤回/版本栅栏、类型与构建检查；配置identity纳入字段经源码审查 | `focused-regressions-final.log`、`integration-core-final.log`、`ci-final.log` |
| B6 | scope/source、Graph与deterministicChunkCap 的0.5非法输入回归 | `focused-regressions-final.log`、`test-all-final.log` |
| B7 | AppThrottlerGuard 包含嵌套路由/伪造查询串不绕过的新增案例 | `test-all-final.log` |
| B8 | standard_ir_eval --selftest：0提交显式coverage0、已提交空排名计0 | `ci-final.log` |
| B9 | 新core-application-permissions实际应用角色/组织/过期授权/restricted ACL/原文来源完整合取 | `integration-core-final.log` |
| B10 | core-graph-projection撤回后依赖1、manifest expectedCount1、未改节点保留与并发源修改拒绝 | `integration-core-final.log` |

以上产物位于 `docs/validation/2026-10-07/`。集成初始严格输出失败、图谱依赖3≠1以及新fixture修改不可变KB组织字段的失败也在测试记录保留；最后一个是fixture问题，改为创建独立兄弟库而未削弱数据库约束。

## 原评估待完成优化/实证

用户已授权本轮 O1–O14 的所有剩余优化。实现进展、失败证据和实证验收分别记录在 [剩余优化实施与验收](SOTA-OPTIMIZATION-COMPLETION-2026-10-07.md)。本节勾选要求对应完整验收通过，不能用“代码已写”替代质量或规模实证。

本轮已新增多跳生成关系链约束、Chat prompt/拒答/完整扫描所有者分离、部署校准阈值应用、全来源Scope编译/真实输出差异/来源生命周期/向量语义导航、社区双通道召回与应用manifest原子写入、完整扫描keyset+snapshot。新数据库fixture覆盖6Source与21001chunk；执行结果以下次Luna验证记录为准。

第一轮20个实际模型oracle配对：引用覆盖0.95→1.00，完整回答本地token F1 0.088253→0.070619，首句F1 0.294713→0.292120。保留退化证据并继续收敛生成；不能据引用覆盖提高勾选O1。该实验不测完整RAG召回。

第二轮同题20配对的完整回答本地F1 0.084729→0.115403，首句0.300558→0.335494；同测试LLM的盲化抽取F1 0.338872→0.425343、关系链支持率0.60→0.65，但逐断言支持比例0.950714→0.948333。原始baseline重复也有波动，且judge `independentModel=false`，因此O1仍等待完整RAG/独立裁决与置信区间。详细混合结果及失败日志见实施与验收文档。

第三轮20配对本地完整回答F1 0.091207→0.132758、首句0.311034→0.382070、同模型抽取F1 0.365035→0.517446；但来源角标覆盖0.9625→0.945833、逐断言支持0.969167→0.947024下降，必要关系链0.60→0.60。三轮结果混合，O1保持未勾选。

当前新增真实数据库 `batch5-compiler.log` 已证明6Source/21001chunk、native topicSQL、真实truthDiff、版本栅栏、社区manifest与并发snapshot；scan851.73ms。源码审查另外修复full Source>500document重复破坏性rebuild导致只剩最后一批，改首批reset/后续append，新增501文档及空来源回归待最终专项。前轮专项18套中17通过/253通过/1失败（阈值尺度问题已修，待最终重测）；故障恢复fixture曾报`Invalid version job identity`、artifact/quota曾中断，完整Jest自然退出尚未最终证明。不得把未完成验收改成勾选。

- [ ] O1 / 原#1：多跳端到端答案F1与全跳证据覆盖，建立可靠配对闭环后优化生成。
- [x] O2 / 原#2：Chat主编排分拆；prompt/source、拒答、完整扫描各自归属清晰，ChatService权限/流式/截断及专项回归通过。完整API测试中相关Chat专项全部通过。
- [x] O3 / 原#3：真实worker SIGKILL、Redis任务删除、持久outbox补投、版本仅发布一次及启动/周期性parser恢复均由隔离测试验证；见 `batch8-service-loss.log`。此证据限于测试覆盖的故障路径。
- [ ] O4 / 原#4：当前源码已在测试API对20个本地数据集、每集100条corpus及全部本地queries/qrels完成只读重测（20/20成功；宏平均nDCG@10 0.826524、MRR@10 0.869546、Recall@10 0.847904；见`batch15-sota20-full.log`和`SOTA-OPTIMIZATION-TEST-RESULTS-2026-10-07.md`）。这不是上游全量语料，也缺同配置配对基线，故尚不能量化结构奖金优化收益。
- [ ] O5 / 原#5：部署对应reranker的留出集校准与拒答精度/召回测量；quality-first原文核验不是概率校准。
- [ ] O6 / 原#6：当前5,206个已发布向量、100条真实查询ANN Recall@10均为1.0；但查询从同一语料抽取、41/100次计划走exact fallback，ANN门禁严格要求HNSW且本次不通过。不能用精确回退结果宣称ANN≥0.98。证据见`ann-current-test-corpus.json`。
- [ ] O7 / 原#7：已实现真实truthDiff、pgvector主题导航、全部Source/chunk与实际生命周期Timeline；6Source/21001chunk及版本栅栏真实数据库通过，501文档source loss修复回归由Luna通过。实际模型综合质量实测仍待完成；显式bounded模式保留预算。
- [ ] O8 / 原#8：已实现full长chunk尾部覆盖、模型失败显式拒绝、社区dense+lexical协同、缺向量恢复及应用manifest写入/读侧守卫。待同语料regex/sample/full收益、成本、时延对照；100000segment安全预算明确保留。
- [ ] O9 / 原#9：keyset分页+RepeatableRead snapshot真实21001chunk、并发源编辑后完整旧snapshot/可见新提交已通过，scan851.73ms；最终全套回归/真实发布并发验收待收敛，最高200000配置不声称无限。
- [ ] O10 / 原#10：真实多进程广播、Redis断线/重连/分区故障回归；TTL兜底期间不能保证零撤销窗口。
- [ ] O11 / 原#11：E2E登录单次认证复用；默认限流/非生产白名单已实现，部署主开关属显式配置。
- [ ] O12 / 原#12：已遍历当前20个本地评测集全部queries/qrels，但每集corpus文件仅100条；仍需上游全量语料、ArguAna缺失positive处理对照、多次配对与置信区间，不能声称leaderboard SOTA/统计等价。结果见`docs/validation/2026-10-07/optimization/sota20-full-current-luna/report.json`。
- [x] O13：2232 artifacts×908 sources、2,026,656依赖；ACL/hash/过期来源、缺失manifest/依赖、匿名用户、KB撤权与并发模型配额通过，隔离fixture清理确认通过。查询约8–9秒，不宣称达到性能目标。见 `batch8-artifact-quota.log` 与 `batch8-fixture-cleanup.exit`。
- [x] O14：关闭ingestion模块Redis/BullMQ资源后，全API Jest以`--runInBand`运行自然退出（162 suites passed、1 skipped；1,379 tests passed、5 skipped、0 failed），没有worker强退/open-handle警告；完整`pnpm run test:all`亦正常退出0。Luna受限sandbox版额外出现EPERM/5433不可达，不代表工作区常规运行结果。见`final-api-direct.log`与`final-test-all-direct.log`。
