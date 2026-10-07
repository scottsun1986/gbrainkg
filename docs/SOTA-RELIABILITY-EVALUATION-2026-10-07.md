# 可靠性、规模与评估证据

2026-10-07。代码开发由 `gpt-6.1-sol` 执行，以下运行验证由 `gpt-6-luna` 执行。未部署、未提交；测试写入只针对本地隔离库 `gbrain_core_opt_test`，当前语料ANN仅只读访问用户授权的本地测试应用库。总体状态见 [实施与验收](SOTA-OPTIMIZATION-COMPLETION-2026-10-07.md)。

| 项 | 已实现与真实验证 | 实证范围及限制 |
|---|---|---|
| O3 | 实际BullMQ子进程领取索引任务后SIGKILL；随机队列前缀任务删除；新真实outbox服务重放持久事件，immutable version恰好发布一次；启动与周期恢复体重新排入丢失解析任务 | [batch8-service-loss.log](validation/2026-10-07/optimization/batch8-service-loss.log) exit0；来源stage原子生成的真实事件，不手造第二事件；批次4的identity失败保留，fixture候选限定修复后通过 |
| O10 | 三个实际OS进程、两个Redis DB、真实断线漏消息与一次性Redis重启；缓存close/ready重置与重订阅 | 批次4真实Redis验证exit0；仅loopback一次性端口/已安装镜像，未重启共享Redis。网络分区期间仍有TTL窗口，最终严格输出实时裁决 |
| O13 | 2232节点×908来源=2026656实际依赖；全部来源ACL/version/hash/time/manifest合取；缺依赖、撤权、匿名拒绝；跨用户/模型8并发调用共享RPM，仅3准入；TPM90+11拒绝 | [batch8-artifact-quota.log](validation/2026-10-07/optimization/batch8-artifact-quota.log) exit0。真实批量守卫8041–9120ms，匿名3ms；不是延迟目标达成或相对历史收益。fixture独立核验残留KB为0 |
| O14 | 诊断定位ingestion.module.spec通过断言后仍持有ioredis TCP连接，测试模块finally关闭；未使用forceExit | 批次6独立open-handle探测自然退出6.73秒；[最终API](validation/2026-10-07/optimization/final-api-direct.log) 与 [普通test:all](validation/2026-10-07/optimization/final-test-all-direct.log) exit0，162API套件/1379assertions通过、5跳过，无worker强退警告。合成超时timer清理独立修复，不能把它说成已观测到的TCP根因 |
| O11 | E2E共享内存会话，按endpoint/persona隔离；同身份并发只认证一次；UI/API切换复用token，错误凭据用独立实际登录路径 | 批次2 SessionCache两项测试通过；完整浏览器验收仍需总验证结果，单元并发测试不代替浏览器证明 |
| O6 | 当前5206个已发布向量chunk、一个embedding fingerprint，100真实来源向量对同库/状态/fingerprint exact KNN；ef_search200、relaxed_order，检查每次实际HNSW计划 | [当前ANN报告](validation/2026-10-07/optimization/ann-current-test-corpus.json)：全部三selectivity桶Recall@10均值/最小值1.0，无短结果；59/100实际HNSW、41非HNSW计划，因此保守ANN资格门禁失败。源向量包含自身邻居，不能外推新查询或更大语料 |
| O4/O12 | 可重跑SOTA20编排、现有token复用/不传凭据argv、全部20库先经认证只读预检，要求实际BEIR文档ID集合与本地corpus精确一致；完整声明topics配对、重复run平均后query bootstrap、插值分位数、Bonferroni simultaneous95%；单topic仅描述性指标并拒绝置信门禁 | 批次9 pairedIR四项与扩展一项测试、批次11只读预检两项测试通过；认证实际20库全部匹配。不同版本完整RAG真实配对run仍由总评估收集，工具正确性不等于质量非劣已成立 |

## 官方语料扩展

[ArguAna profile](validation/2026-10-07/optimization/arguana-1000/manifest.json) 保存完整8674文档语料，按固定seed/hash选取1000topics。1406官方topics中有5个正例文档在分发语料中缺失；严格默认拒绝，显式exclusion配置按整个topic排除并记录缺文档ID与所有源/产物SHA256，1401topics可用。保留topic的全部正例判断不被裁剪，完整语料包含全部distractors。`corpus.jsonl`与源字节hash一致；`qrels/test.tsv`与审计qrels一致。`leaderboardComparable=false`，不能声称官方全topics成绩。

重现：

```bash
python3 tests/evaluation/intl-benchmark/expand_official_topics.py \
  --source /tmp/gbrain-beir-download-20261007/arguana-raw/arguana \
  --out docs/validation/2026-10-07/optimization/arguana-1000 \
  --topics 1000 --exclude-incomplete
python3 tests/evaluation/intl-benchmark/paired_ir_eval.py \
  --manifest /path/to/actual-paired-runs.json --out /path/to/paired-report.json
```

paired manifest必须提供完整corpus/queries/qrels、等数量baseline/candidate真实run文件和双方gitCommit/workingTreeHash/modelFingerprint。缺topic或重复topic拒绝，实际提交空排名记0；manifest的inputScope必须诚实说明搜索语料范围，文件hash不能证明API确实搜索过全语料。重复同题不是新增独立topic；bootstrap抽样单位为query。

只读SOTA20预检先核对所有20个当前用户可见的既有库：published/ready文档数量和不同BEIR ID集合均须等于本地corpus；同名库只允许一个完整匹配者，多匹配拒绝。没有创建、重置或摄入库的fallback。用户提供本地测试登录凭据后，实际认证预检全部20库匹配，取代先前未经认证的跨owner目录重复名称判断。凭据/token不写报告或argv。

一次重复启动的诊断在协调方要求下停止，保留 [取消记录](validation/2026-10-07/optimization/sota20-current-r1/cancelled.json)：scifact40topics、nfcorpus5topics完成，arguana中途停止；它不是完整20集、固定新版runtime或配对收益证明。唯一完整基准由总协调方加载新构建的本地测试API后运行。正常模型配额与查询缓存/Scope元数据写入已获授权，`--read-only`指不变更知识库内容、授权或摄入状态。

## 实际重排序校准诊断

配置测试reranker对40个真实检索候选池测得800pairs，正例40、closed-world未判断/非相关760。候选不注入gold或人工distractors。部署网络route只留SHA256；模型、来源corpus/queries/qrels/candidate run hash保留。未取得immutable deployment revision，默认fit拒绝且没有输出/激活运行profile。

[留出诊断](validation/2026-10-07/optimization/rerank-holdout-diagnostic.json) 按query hash分离：28queries/560pairs训练、12queries/240pairs验证。Platt仅训练分区拟合，阈值0.95预先声明，验证集不调参。query-cluster bootstrap2000次，pair Wilson区间仅描述性。

| 留出指标 | 测量 | 解释 |
|---|---|---|
| pair拒绝precision | 0.957983，238拒绝；cluster95% [0.950000,0.970213] | 10个相关pair被拒绝 |
| pair拒绝recall | 1.0，228非相关pair；cluster95% [1,1] | 仅12个query groups，完美样本不证明总体零漏拒 |
| pair接受precision | 1.0，仅2接受pair | query bootstrap区间不稳定，报告null |
| pair接受recall | 0.166667，12相关pair；cluster95% [0,0.416667] | 当前阈值拒绝多数相关证据，不应据高拒绝precision直接部署 |
| Brier | 0.033295 | 仅此次候选分布、IR relevance标签 |

这些标签不是事实entailment或query answerability，不能作为问答拒答precision/recall。还需固定实际部署revision并收集适当的事实支持/无答案query金标；不通过虚构revision或学习常量关闭O5实证门禁。

```bash
python3 tests/evaluation/fit_rerank_calibration.py \
  --labels docs/validation/2026-10-07/optimization/rerank-observed-labels.json \
  --diagnostic-only \
  --report docs/validation/2026-10-07/optimization/rerank-holdout-diagnostic.json
```

## 运行边界

集成运行器构建后顺序运行故障与规模场景：`python3 tests/integration/run-core-checks.py --reliability`。单次规模fixture较重，分批进度和SQL超时用于明确阶段；不得并行重建同一fixture或用FLUSHDB消除残留。批次8全部进程自然退出且限定fixture清理通过。旧批次4的209秒DataFileRead中断不是当前成功运行的延迟，不删除失败记录。

新的应用读/写边界记录在 [RLS-BOUNDARIES.md](RLS-BOUNDARIES.md)，当前验证不依赖已移除的数据库RLS或历史GUC授权函数。无production、部署、迁移或外部消息发送。
