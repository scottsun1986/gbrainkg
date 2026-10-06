# 全球 SOTA 验证与优化执行记录（2026-10-05）

## 执行分工

用户指定 `gpt-6-luna` 执行评测、`gpt-6.1-sol` 修改代码。本轮由两个 luna 代理分别执行真实新评测和历史原始结果审计；sol 代理负责所有产品及评测源码修改、回归验证和已确认的本地测试服务操作。主代理负责证据审查、官方口径核验和验收。

生产服务器 `meetings2`、生产域名 `knowledge.5gsailor.com` 的发布、迁移和重启仍须遵守 `AGENTS.md`。本机 3202 实例由既有文档、本地进程路径及 Docker 配置共同确认是测试实例；`NODE_ENV=production` 本身不代表它就是远端生产。

## 可宣称结果的边界

目标是通过可复现的同口径比较证明领先。内部门禁通过、抽样包含率高、组件名称先进都不是全球领先的证明。

- BEIR 使用官方 corpus、queries、qrels 和保存的逐题 run，分别报告 nDCG@10、Recall@100、MRR 和 MAP。完整 corpus 与保证金标存在的缩小语料必须分开标记。来源：[BEIR 官方仓库](https://github.com/beir-cellar/beir)。
- BEIR 的 MAP@k 使用 `pytrec_eval` 的 `map_cut`，分母是全部相关文档数；不能使用 `min(R,k)`。默认是否排除查询与文档相同 ID 必须与对照设置一致。来源：[BEIR evaluator](https://github.com/beir-cellar/beir/blob/main/beir/retrieval/evaluation.py)、[trec_eval map_cut 实现](https://github.com/usnistgov/trec_eval/blob/master/m_map_cut.c)。
- HotpotQA 的 distractor 与 fullwiki 属于不同设定。正式比较需要答案、支持事实及联合 EM/F1，100 题、300 篇语料的内部回归不能直接对比全量官方榜单。来源：[HotpotQA 官方项目与榜单](https://hotpotqa.github.io/)。
- MuSiQue 区分 Answerable 与 Full，使用官方 evaluator 的 answer_f1、support_f1 等对应指标。来源：[MuSiQue 官方仓库及 evaluator](https://github.com/StonyBrookNLP/musique)。
- LLM judge 是质量诊断的一部分，不能替代官方答案与支持事实指标。没有逐题原始答案和证据的旧报告，不能重新估计忠实度。

## 已确认的本轮发现

1. `fetch_datasets.py` 原实现即使不设置文档预算，也只保留 qrels 涉及的文档，删除了其他检索候选。这使默认“全量”下载输出偏离官方语料。修复必须保留完整 corpus，固定种子和输出顺序，并拒绝缺正金标或无法满足的预算。
2. `standard_ir_eval.py` 原 MAP@k 使用 `min(R,k)` 分母，与 BEIR/trec_eval 不同，会在相关文档数大于截断深度时抬高结果。
3. `sota-gate.sh` 原实现全库清理 SemanticCache、吞掉 pytest 失败后读取旧报告、在硬探针样本数不符时跳过判断。修复必须避免共享数据破坏，使用本次独立产物，完整检查题数及环境错误。
4. 旧 SOTA10 的四个 BEIR 任务使用不超过 30 篇的定制语料；结果缺运行模型、commit 与语料 manifest。SciFact 存在重复排名 ID，需对唯一文档排名重算。企业“220 题”若含 30 个 corpus_absent，只能报告实际 190 个有效样本。
5. 初次运行先完成默认 KB 的 2Wiki 100 题检索，随后 Hotpot 探针失败：认证 `/auth/me` 返回 200；知识库列表返回 200；单条 Hotpot 搜索返回 500，约 89 秒。服务日志显示已得到 15 个候选，但重排等待耗尽共享预算，最终 ACL/RLS 校验抛出 `Query execution deadline exhausted`。中止的后续数据集没有成绩；已完成的 2Wiki 结果保留为旧进程基线，不能抹掉，也不能标成本次修后构建。
6. `/chat/search` 原上限为 50，BEIR harness 默认请求 100。对 50 个结果计算 Recall@100 仍可得到合法指标，但必须披露实际检索深度，不能称其验证了 100 候选的能力。

## 本轮验收顺序

先修评测口径与产物有效性，再修已被真实日志证明的检索预算问题。最终 ACL 必须完成，不能以绕过权限来降低延迟。修复只在已确认的本地测试实例构建和加载；新运行记录进程版本与启动时间，不能把当前工作区 commit 自动当作旧进程实际加载版本。

修后先对同一失败问题验证 HTTP 状态、延迟、候选和授权边界，再跑固定问题集。正式结果记录完整题数、原始响应/排名、模型配置来源、语料与问题哈希、错误数和缓存状态。旧数据重算与修复后新运行分别保存，禁止把重算变化宣称为产品质量提升。

历史审计与新运行产物会保留在独立目录，结果汇总以实际产物为准。全球 SOTA 判定仍需完整官方设定下与可复现对照系统比较，并满足权限、安全、延迟及容量要求。

## 已完成修复与验证

- 修复完整 corpus 下载、MAP@k 分母、检索收集器认证/协议校验和独立门禁产物。真实空检索仍计零分；HTTP/transport/JSON 错误使 run 无效。新自检已接入 `benchmark:selftest`。
- 原生 `/api/v1/chat/search` 支持最多 100 条，拒绝非正有限整数；外部 open-api 资源契约仍为 50。不能把 chunk 数直接宣称为唯一文档检索深度。
- 最终 ACL 复用已有独立授权预算模式，只脱离可选检索执行预算，保留请求身份、权限快照和取消信号。ACL 失败仍拒绝输出，预算耗尽后不继续补充检索。重排已有共享 deadline 信号，本轮补测试，不冒称新实现。
- 全量串行测试：136 套件、1159 通过、5 跳过；类型检查、lint、API build、评测自检通过。首次并行测试中 user-credential 两项触发 5 秒 deadline，原样独跑及串行全量通过，未降低阈值或增加 skip。
- 本地测试 API PID `2653629`，启动于 `2026-10-05 00:36:27 CST`。修后同题探针：10 条 HTTP 200、3.886 秒；100 条 HTTP 200、4.372 秒。原始响应与构建指纹见本轮 `diagnostics/hotpot-depth-probe.json`。旧进程实际加载版本及缓存条件未完全控制，故仅证明搜索恢复，不能把差值归因于单一 patch。

## 数据与运行记录

本轮路径：`tests/evaluation/intl-benchmark/results/luna-fresh-20261005-161918/`。历史审计见 [审计报告](../validation/sota-20261005/HISTORICAL-AUDIT-2026-10-05.md)。

旧进程新采集的 2Wiki：`intl-2wiki-20261005-002419.json`，100 题、零 API 错误，Recall@10=0.7075、完整证据率=0.39、MRR@10=0.99、nDCG@10=0.7543。SHA-256=`367ee2277f23bd1327d23ead976982c48aa1ea02c36e02ad1cccc5dcba70f25d`。这是默认 KB（当前只读核验 770 个 published/ready 文档），不是 profile=300，也不是已证明完整官方语料；上述为现有 title/chunk 位次指标，独立文档口径需要另算。

**历史运行标记：下列三套各 100 题结果采集时 RAPTOR/重排未生效。** 2026-10-05 后续核查确认派生 RLS 守卫耗尽检索预算；这些数据不代表完整混合架构的能力。迁移修复后的结果必须单独记录，不能混用。见 [缺陷记录](../validation/sota-20261005/bug-findings-2026-10-05.md)。

修后固定三套各 100 题检索运行位于 `current-runtime-retrieval-100/`，已全部完成，API 错误均为 0；每次记录 HEAD、dirty 指纹、dist hash 与 PID/start，避免把 dirty 构建称为纯 commit 构建。来源与逐题产物见该目录 `provenance-summary.json`。

| 数据集 | 题数 | Recall@10 | 完整证据率 | MRR@10 | 文档去重 nDCG@10 | 检索阶段耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2Wiki | 100 | 0.7075 | 0.39 | 0.99 | 0.7563 | 284.63 秒 |
| Hotpot | 100 | 0.95 | 0.90 | 0.9473 | 0.9067 | 309.74 秒 |
| MuSiQue | 100 | 0.6950 | 0.37 | 0.9183 | 0.7067 | 316.53 秒 |

这些是默认本地 KB 的检索探针，不是官方全量公开榜单成绩；没有重跑答案生成或 judge 质量评分。实际检索模型配置为 `BAAI/bge-m3`（1024 维）与 `BAAI/bge-reranker-v2-m3`，luna 是评测操作者。模型权重 revision 未记录，缓存命中/预热状态未控制，均不得假设。

2Wiki 新旧同库同题的 Recall@10、完整证据率、MRR 相同；原始 nDCG@10 为旧 0.7543、新 0.7555，去重后为旧 0.7552、新 0.7563。不能把小差值归因于单一修复。对历史 v15 的自动差值因缺少运行时和语料对齐证据仅作排查信号，不作为改善或回归的因果结论。

只读语料审计已证：2Wiki 全部 262 个金标标题实例均 published/ready 且有 chunk，Hotpot 全部 200 个亦就绪。2Wiki 61/100 题缺完整证据，四跳题只有 2/31 完整；Hotpot 10/100 题缺完整证据。重复片段不足以解释这些缺失。应先追查通用多跳 bridge 的逐轮候选和停止条件，不能加业务专用同义词或针对基准答案的补丁。

judge 报告已保留完整答案与问题、实际送入 judge 的 evidence/prompt、每次原始 completion/解析 assertions/validity/error，以及脱敏配置；保留旧 400 字预览以兼容报告使用方。完整及失败 trace 的 CLI mock 自检、独立类型检查、评测全部自检通过。这是可复现性修复，mock 分数不是实际系统质量成绩。

官方 SciFact 已完整下载：5183 文档、300 测试问题、339 条 qrel；ZIP SHA-256=`536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165`。现有 full-retry KB 的 5183 个索引 outbox 处于历史 dead 状态，抽查原因是测试环境共享 enrichment 队列饱和时人为暂停。当前队列 wait=0/active=0，parser systemd 服务存在；不能写成缺少 worker。

单条标准 replay 返回 201、event completed，但文档仍 pending：原因是整个个人 KB 已 archived，worker 正确执行 superseded 停止逻辑。现有 API 没有恢复个人 KB 的端点，因此没有直接写 DB 或改 worker 绕过保护。已通过标准 API 创建新的官方 SciFact 专用测试 KB `f7d28686-ff50-44a9-8c20-67a0cb976eb6`，固定10个官方 ID pilot 达到10/10 ready。随后分批任务在用户提出达到910篇后停止时已提交至1110篇；最终1110/1110 ready、没有未 ready 文档可删。其余4073篇从未入库。现有局部语料只覆盖283个正相关文档中的95个，不能当全量 SciFact 成绩，也不足以公平评测所有300题。旧 archived 测试库还留有5,183与593篇未 ready 记录，但已有 API 没有清除 archived personal KB 文档的安全路径。详见 [索引恢复与清理盘点](../validation/sota-20261005/scifact-recovery.md) 与 `scifact-pilot/` 产物。
