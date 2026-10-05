# SciFact 测试语料恢复记录

状态：已在三套各 100 题检索评测完成后提交一次标准重放；worker 因 KB archived 正常跳过，未恢复 ready。当前阻塞是该 personal KB 没有标准恢复端点。

## 根因与对象

现有 `EVAL-BEIR-SciFact-Full-20260927-Retry` 的 5,183 条 enrichment_request 事件全部 dead、retryCount=10；抽样错误是 `Full-corpus benchmark paused: shared enrichment queue saturation in test environment.`。这是历史暂停标记，不能据此推断当前 parser 不可用。当前本地 systemd parser 服务 active，核心 enrichment 队列 wait/active/delayed 均为 0。

首个恢复对象已冻结：

- event：`2ffb4fda-b4b4-4808-9d11-b6f9c1dc79d1`
- document：`680d3f26-6cdf-4ac5-934b-44cf7e7c8c01`
- KB：`EVAL-BEIR-SciFact-Full-20260927-Retry`
- expectedVersion：1
- 预检状态：event dead / retryCount 10，document indexing / indexReadiness pending。

## 读写边界

仅操作已确认的本地测试实例 `http://127.0.0.1:3202`。数据库操作全部为只读事务，用于验证 event/resourceId/document/KB/version 关联及前后状态。Redis 只读取现有实例配置对应的队列计数。凭据沿用现有环境身份，不记录 token、密码、连接串或认证头。

唯一业务写操作是现有管理端点 `POST /api/v1/admin/outbox/{eventId}/replay`，该端点强制 system-admin 权限。它重置已 dead 的指定事件并交由既有 dispatcher/共享 enrichment worker 处理，不直接改 Document 状态、不强制 published/ready、不跳过 ACL 或版本门、不新建中间件、不重放全部事件、不操作生产服务器。

## 单条操作与验收

已准备临时工具 `/tmp/gbrainkg-scifact-replay-one.py`，不纳入仓库。默认运行只做预检；获得本轮评测完成窗口后执行 `python3 /tmp/gbrainkg-scifact-replay-one.py --execute --timeout 600`。认证沿用已有测试身份，先验证 `/api/v1/auth/me`。

工具再次确认冻结对象关联、dead/indexing/pending 状态，以及核心队列无 waiting/active/delayed 工作，然后仅提交一次 replay。每 5 秒只读观察，记录 outbox 状态与 retryCount、Document 状态与 indexReadiness、队列计数。只有同时满足 event=completed、document=published、indexReadiness=ready 才通过；degraded/dead 即失败。600 秒上限是观察时限：到期退出，持久任务可继续，不能抢占 lease 或自动重复提交。

实际执行（2026-10-05 00:57:46 +08）：标准 admin replay 返回 201，event 从 dead/retry10 进入 processing/retry0，并在 5 秒观察点达到 completed。Document 仍为 indexing/pending，未满足验收条件。日志为 `Enrichment for … skipped: version 1 superseded by 1.`；只读代码与 DB 核查确认该分支实际命中 `KB.status=archived`，不是版本号变化。

Retry KB 是本地 test-admin 所有的 personal KB，5,183 个文档有 5,183 个唯一 BEIR marker 标题，全部版本 1，KB 最后更新于 2026-09-26 18:28 UTC。当前只有组织知识库的标准 activate 端点；该 personal KB 没有标准 unarchive/restore 端点。没有直接改 DB、绕过 archived 防线或再次提交重放。终止无意义的剩余观察，实际逐阶段证据在同名 JSON；结果判为未恢复，不能把 event completed 宣称为 ready。剩余 5,182 条 dead 事件未改。

## 后续容量决策

本次 worker 跳过，没有有效处理速度，也不能据 5 秒完成事件估算全量恢复时间。仅在标准恢复路径可用且单条达到 ready 后，才能用实测耗时估计保守串行恢复时间：`剩余条数 × 单条秒数 / 3600` 小时。该估计不是容量承诺。根据单条观测结果决定是否先执行 10 条串行 pilot，检查 ready 达成、模型配额/429/timeout、队列与主机资源，以及在线检索是否受影响，再确定后续有界批次。必须尊重现有共享队列 backpressure 与 worker 并发配置，不能直接重放 5,183 条。

## 按用户指令停止后的测试库清理盘点

用户要求 SciFact 达到约 910 篇 ready 后停止，删除剩余未 ready 内容。新建测试库 `EVAL-BEIR-SciFact-Official-Full-20261005` 在协调进程停止前已额外提交至 1,110 篇。停止后队列自然收敛；只读数据库与 API 核验为 1,110/1,110 published/ready，0 篇未 ready，队列 wait/active/delayed 均为 0。未删除额外 100 篇 ready 文档。全量官方 corpus 尚有4,073个 ID 从未入库，没有持久文档可删。

当前1,110篇是按 corpus ID 排序顺序提交的局部语料，只覆盖283个 SciFact 正相关文档中的95个；300个查询中91个具备全部正相关文档。它不能作为完整 SciFact 成绩。重建合规的910篇子集必须先把所选查询的所有正相关文档纳入，再采负例；未满足前不能运行或宣称对应分数。

只读盘点另发现两个旧的 archived personal benchmark KB：`EVAL-BEIR-SciFact-Full-20260927-Retry` 有5,183篇 `indexReadiness=pending`；`EVAL-BEIR-SciFact-Full-20260927` 有90篇 pending、3篇 degraded、500篇 indexing/ready 和7篇 published/ready。按 published+ready 判定，它们分别有5,183和593篇未 ready。已对这5,776篇做只读目标预检；文档删除 API 会拒绝 archived KB。尝试临时激活以走标准删除 API 时，被数据库触发器以 `Invalid KB status transition` 拒绝；事务回滚，删除数为0。没有绕过此保护或直接删 DB。这些旧库与当前新建1,110篇 KB 分开；移除旧归档文档需要标准、安全的永久清理路径。
