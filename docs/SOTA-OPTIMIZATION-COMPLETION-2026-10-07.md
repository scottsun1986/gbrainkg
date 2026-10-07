# SOTA 剩余优化实施与验收

日期：2026-10-07。开发使用 `gpt-6.1-sol`；执行验证使用 `gpt-6-luna`。保留前轮未提交修改，没有提交或生产发布。实现、回归与实际质量门禁分开记录，构建/单测通过不等于国际榜单 SOTA。

关联：[TODO](SOTA-FIX-TODO-2026-10-07.md)、[前轮实施审计](SOTA-IMPLEMENTATION-AUDIT-2026-10-07.md)。本轮产物位于 `docs/validation/2026-10-07/optimization/`。测试 API `127.0.0.1:3202` 已确认可用，用户明确授权使用测试模型。数据库集成限制在 `gbrain_core_opt_test*`，未使用生产数据库。

## 逐项验收

| 项 | 实现验收 | 实证验收，不能被实现替代 |
|---|---|---|
| O1 | 多跳生成逐关系绑定原文来源、缺口不补造；首句最短决定性答案，链最多补一句；无原文证据不走快速拒答例外。 | 同金标配对的短答案正确性/逐关系支持率；oracle context不测召回，来源角标覆盖不等于全跳蕴含。完整RAG答案F1另测。 |
| O2 | prompt/source assembly归`answer-prompt.ts`，拒答归`evidence-sufficiency.ts`，完整扫描归`deterministic-scan.ts`；复用既有retrieval/fusion/citation/stream所有者，保留ChatService导出/引用编号/双语规范。 | 构建与模块、原ChatService权限/流式/拒答/截断回归；不以任意拆文件数量代替边界明确。 |
| O3 | 隔离服务检验既有持久outbox/watchdog恢复。 | 真实kill/restart、Redis任务损失补投、终态/重复投递幂等；mock不能代替故障注入。 |
| O4 | 沿用前轮去结构奖金与通用混合检索。 | 多语料、同样本真实配对；单个多跳oracle实验不替代SOTA20回归。 |
| O5 | route/model/revision绑定Platt profile；optional阈值与概率同profile；逐候选比较，禁止rawscore与概率阈值混用；合成/未重排候选不伪装概率。无真实样本不生成部署系数。 | 真实训练/留出分离、样本门槛、拒答precision/recall/calibration及corpus/validation hash；预声明operating point不宣称由留出集优化得到。 |
| O6 | 当前规模/embedding身份/ACL过滤的ANN与exact对照门禁。 | 当前测试语料Recall≥0.98；历史100k、假向量结构fixture不作为当前质量证据。 |
| O7 | 默认全部Source/全部发布文档chunk输入覆盖；`BRAIN_SCOPE_FULL_COVERAGE=0`显式保留预算。真实hash/增删行/来源版本diff、实际lifecycle timeline、BGE-M3 chunk centroid导航；相似不是事实关系。源版本/epoch漂移拒绝发布。成功CompileJob记录实际页面前后diff，读取失败显式unknown。 | 6Source、>40chunk、21001chunk数据库覆盖、真实内容变化、版本栅栏、pgvector关联SQL与来源审查。完整输入不等于模型利用全部事实；模型综合质量另测。 |
| O8 | full覆盖长chunk尾部/短原文并覆盖采样设置；缺LLM/调用失败/segment预算溢出显式失败。社区dense+lexical RRF，相关过滤先于top-K，不先截最新社区；缺向量维护补写，模型身份入增量指纹。社区依赖/manifest与产物原子应用写入、版本栅栏；读守卫先于LIMIT。 | 同语料regex/sample/full实际收益成本时延；100000segment是安全预算，不是无限full。 |
| O9 | `(documentId,ord,id)`keyset替代OFFSET，RepeatableRead内count/scan；超预算/短页/不前进安全返回不可确认；保留原文hydration/output权限门禁。 | 21001chunk数量/去重、并发删除的旧snapshot完整性、新snapshot见提交、实际耗时；配置上限不代替规模证明。 |
| O10 | Redis DB频道隔离、重连/多进程失效，数据库及输出门禁仍是权限权威。 | 真多进程、断线/重连/分区；TTL容错不声称零撤权窗口。 |
| O11 | E2E复用单次认证会话，缓存拒绝异常/过期形状。 | 真实浏览器登录/并发复用，不以mock鉴权代替。 |
| O12 | 配对输入身份、缺失提交失败、oracle/完整RAG/IR/官方口径分离。 | 扩大真实金标、多次重复/置信区间；20题不证明统计等价/leaderboard SOTA。 |
| O13 | manifest/source ACL/version/hash/生效期合取批量验证；模型配额按当前应用身份/worker裁决，移除旧RLS GUC函数依赖。 | 2232artifact×908source真实数据库边界/性能与模型配额竞争/拒绝。 |
| O14 | 清除synthesis race成功/失败/超时后的timer；Redis/HTTP句柄根据实际诊断定位。 | 完整串行Jest自然退出；强退/timeout不能勾选完成。 |

## 第一轮实际生成实验

`paired-multihop-generation.json`：20个oracle-gold-context配对、40次实际模型调用，无缺失配对。两组收到相同金标文档上下文，baseline静态提示固定Git HEAD，candidate使用相同规则与新增多跳指令。保存完整回答、问题、gold、context/input/prompt hash和模型身份，不输出凭据。

| 指标 | Baseline | Candidate | 结论范围 |
|---|---:|---:|---|
| 本地完整回答token F1 | 0.088253 | 0.070619 | 下降，新增关系链增加文本；不能掩盖这项结果。 |
| 首句本地token F1 | 0.294713 | 0.292120 | 略降，不能宣称答案更正确。 |
| 金标来源角标覆盖 | 0.950000 | 1.000000 | 提高，仍不等于逐跳关系蕴含。 |
| 平均调用ms | 957.85 | 1097.40 | 增加约140ms，不是完整检索延迟。 |

第一轮退化证据保留。已据此把生成规则收敛为最短答案、最多一句关系链，须用同baseline/同样本重测。`judge-paired-multihop.ts`盲化评分不见gold答案/arm身份：抽取回答实际短答案并逐事实核对来源；同模型时明确`independentModel=false`，不冒充独立人工评审。

## 第二轮与盲化诊断

第二轮 `paired-multihop-generation-v2.json` 仍为20个完整配对/40次真实调用，使用同样题集/上下文/基线提示，candidate 为收敛后的短答案规则。基线完整回答F1也从第一轮0.088253变为第二轮0.084729，表明重复调用存在随机波动；这两轮不能证明统计等价或稳定优胜。

针对第二轮实际不支持的断言，第三版仅加强通用约束：先核对问题准确属性、重用实体的身份属性和逐跳连接；同名或邻近属性不作为关系证明；未解决关系不先给肯定答案。成立时首行仅为最短取值/完整名称加角标。没有针对具体题目或业务设置词表。

| 第二轮指标 | Baseline | Candidate |
|---|---:|---:|
| 本地完整回答token F1 | 0.084729 | 0.115403 |
| 首句本地token F1 | 0.300558 | 0.335494 |
| 金标来源角标覆盖 | 0.975000 | 0.983333 |
| 平均调用ms | 1009.40 | 979.65 |

两轮盲化诊断产物为 `paired-multihop-judgment-v1.json` 和 `paired-multihop-judgment-v2.json`，各20个完整配对。**实际 `independentModel=false`：评分仍使用相同测试LLM，只有输入盲化，未使用独立模型或人工评审。** 抽取短答案不见gold，也不允许以来源中的另一个答案修正生成结果；抽取后本地F1只用于诊断。

| 诊断 | 第一轮 Baseline→Candidate | 第二轮 Baseline→Candidate |
|---|---:|---:|
| 抽取短答案本地F1 | 0.339244→0.369397 | 0.338872→0.425343 |
| 逐断言支持比例 | 0.973333→0.943274 | 0.950714→0.948333 |
| 必要关系链全部支持比例 | 0.700000→0.650000 | 0.600000→0.650000 |

结果混合：第二轮本地答案指标提高，逐断言支持比例仍略降；第一轮关系链支持率下降。O1 的完整RAG答案F1、独立关系核验及重复配对置信区间保留未完成，不能用引用覆盖或同模型评分代替。

第三轮 `paired-multihop-generation-v3.json` 和 `paired-multihop-judgment-v3.json` 各20个完整配对，仍是相同测试模型、`independentModel=false`。精确结果：

| 第三轮指标 | Baseline | Candidate |
|---|---:|---:|
| 本地完整回答token F1 | 0.091207 | 0.132758 |
| 首句本地token F1 | 0.311034 | 0.382070 |
| 金标来源角标覆盖 | 0.962500 | 0.945833 |
| 平均调用ms | 1003.90 | 881.50 |
| 盲化抽取短答案本地F1 | 0.365035 | 0.517446 |
| 逐断言支持比例 | 0.969167 | 0.947024 |
| 必要关系链全部支持比例 | 0.600000 | 0.600000 |

第三版的本地答案指标提高、文本/延迟减少，但来源引用覆盖和同模型逐断言支持比例下降，完整关系链支持比例未提升。仍出现属性替换和同名实体拼接：提示不能代替应用逐句grounding。Oracle实验直接调用模型，未经过应用grounding/权限/检索流水线，所以不能据它宣称实际产品端到端安全/质量达标。三轮完整原始记录均保留。

## 回归与未完成门禁

最终命令/退出码/通过数以本轮验证产物及追加记录为准。首次来源Map类型错误、完整扫描短页异常、概率阈值与旧rawscore混用均保留失败记录，修复后重测。

未获得的实证不勾选SOTA完成：多语料完整RAG质量/重复置信区间、部署reranker足量真实留出校准、当前embedding/ACL比例ANN≥0.98、sample/full社区模型收益成本对照。后续只追加实测结果，不凭实现推断模型分数。

当前读取到的精确证据与缺口：

| 产物 | 实际结果 | 后续门禁 |
|---|---|---|
| `batch3-adapter-build.log` | Adapter构建通过，新增实际页面读取审计入口。 | API及集成必须使用新构建。 |
| `batch3-api-build.log` | 来源Map类型报4错，已修复为明确投影类型。 | 后续构建验证；`batch4-reliability.log`内后续API构建通过。 |
| `batch3-*.log` 专项 | 18套中17套通过；253通过/1失败，失败是概率阈值在旧rawscore路径取错比较尺度。 | 源码已修复为概率对概率阈值并新增高raw/低prob回归；最终重测尚无产物，不能声称254全部通过。 |
| `batch4-reliability.log` | 版本、增量图谱、替换摄入、应用权限四项数据库脚本通过；服务故障fixture失败`Invalid version job identity`，流程退出1。 | O3失败保留，不能声称混沌回归完成。 |
| `batch4-artifact-quota.exit` | `-15`：运行中断，没有最终通过证明。 | O13规模/配额fixture待重跑。 |
| `batch4-redis-reconnect.exit` | 0。 | 只支持该脚本覆盖的本地断连/重连场景，不承诺任意分区零撤权窗口。 |
| `batch4-rerank-selftest.exit`、`batch4-paired-ir-selftest.exit` | 均0。 | 校准/配对工具证明；真实部署足量校准及完整语料排名未测。 |
| `leak-module.log`、`leak-version.log` | ingestion模块存在ioredis TCP活动句柄并timeout124；version专项7/7自然退出0。 | 模块资源关闭已修改但未有最终自然退出证据，O14不勾选。 |
| `official-expansion.log` | 官方ArguAna归一化拒绝positive qrel指向缺失corpus文档；原始下载hash保留，扩展未执行。 | 不吞掉金标缺失，不宣称已完成扩展官方评测。 |
| `batch5-compiler.log` | API构建及四项旧数据库回归通过；新增compiler fixture真实数据库通过：6Source、4派生页、21001chunk、真实truthDiff、native pgvector关联、源变更拒绝、并发snapshot、原子社区manifest。完整scan为851.73ms，整组17.03s，退出0。 | 这是本地数据库行为证明，synthesis与向量为明确fixture；不宣称真实模型综合质量。 |

已落地的其余工作与证据范围：O5校准工具要求按query分组隔离训练/留出、留出≥200与部署身份hash，预声明阈值附带query cluster bootstrap；实际部署分数采集/足量标注仍待执行。O6工具要求实际HNSW plan、非trivial样本和ACL分桶门禁，selftest不替代当前语料实测。O11会话缓存工具2个单测通过，完整浏览器复用尚未证明。O12重复query配对IR工具3个selftest通过；官方ArguAna缺失positive不能静默丢弃，显式排除必须有审计且不得宣称leaderboard全量等价。O3/O13故障与规模fixture需要修复/重跑后才增加通过记录。

最终源码审查另发现并修复O7的规模完整性根因：full Source同步原先对每个500document分页重复调用**破坏性**`rebuild`，Adapter会删除本批以外所有canonical页面，导致>500文档只保留最后一批。现改为按id稳定分页、首次rebuild清理旧页、后续`ingest`追加；空inventory也rebuild空集合清理orphan。新增501document回归模拟真实破坏性语义，核对全部501页/501唯一mapping，等待Luna最后专项结果。O5概率阈值已额外阻止legacy rawscore缺失/0时走unknown-confidence绕过；profile新增SHA256 `routeHash`绑定支持，避免持久化明文provider route，仍保留旧明确route兼容。

## 最后一轮验收

稳定源码由Luna重验API build与`evidence-calibration`、`evidence-sufficiency`、`brain-compiler.service`三套：25/25通过，routeHash和501-source分页回归通过（`batch7-*`）。O3实际worker kill、Redis job丢失、outbox重投、版本仅发布一次及启动/周期parser恢复均通过（`batch8-service-loss.log`）。O13在隔离数据库装载2,026,656行后，ACL/hash/期限/manifest/anonymous/revocation/model-quota断言全通过并确认清理；实测守卫约8–9秒，说明正确性而非性能目标达成（`batch8-artifact-quota.log`）。

O5对800条真实reranker观察分数作query组隔离留出诊断（560 train / 240 holdout）。公开qrels上的IR拒答precision 0.958、recall 1.0、Brier 0.0333；只批准2个回答，answer precision 1.0、recall 0.167。该数据是qrels检索相关性，不是answerability/事实蕴含标签。缺不可变deployment revision，默认模式拒绝profile，诊断模式未写入或启用系数。因此O5仍不完成。

O6对测试库5,206个published向量和100条真实向量查询得到ANN Recall@10均值/最小值1.0，三档过滤桶均为1.0；但查询来自同库含self-neighbor，只有59/100查询计划使用HNSW，其余走exact fallback，strict ANN-only门禁失败（`ann-current-test-corpus.json`）。不宣称达标。

最终Luna只读重测当前测试API上20个SOTA20库，完整使用各本地100条corpus文件并遍历本地全部queries/qrels，20/20成功；宏平均nDCG@10 0.826524、MRR@10 0.869546、Recall@10 0.847904。此处full-corpus指未截断本地评测文件，不代表上游语料全量。结果与旧报告配置/样本并非同条件配对，故O4仍未完成；完整上游基准、独立质量裁决与置信区间仍待执行，O12也保持未完成。原始结果见`docs/validation/2026-10-07/optimization/sota20-full-current-luna/report.json`，退出码0见`batch15-sota20-full.exit`。

Luna受限sandbox中的首次`pnpm run test:all`退出1：API 1,376 passed / 3 failed / 5 skipped；两个失败分别因本地5433数据库不可达和sandbox监听`0.0.0.0`返回`EPERM`，worker强退警告也出现在该受限运行。随后在工作区常规测试环境重跑完全相同的`pnpm run test:all`，退出0：API 162 suites passed、1 skipped（1,379 tests passed、5 skipped），parser 54 tests+4 subtests通过，adapter 17/17通过。额外全API `jest --runInBand`自然退出0，无worker强退/open-handle警告。因此O14自然退出验收完成。逐命令证据见[测试结果](SOTA-OPTIMIZATION-TEST-RESULTS-2026-10-07.md)。

O2、O3、O13、O14满足本轮验收并在TODO勾选。O1、O4–O12仍按各自未达成的质量、数据或完整性门禁保持未勾选。所有测试仅使用测试配置；没有生产部署。
