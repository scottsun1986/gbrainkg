# GBrain 最佳实践复核与问答调用链验收（2026-09-04）

## 结论

当前实现已经形成适合本平台业务权限模型的 GBrain 企业化架构，核心路径符合官方关于多 Source、显式 Source 路由、Source 级引用、Git 持久源、增量同步和 Compiled Truth/Timeline 的主要原则。它不是“每个用户复制一套完整 GBrain”，而是：

- 每个有效知识库对应稳定、隔离的原始 Source；
- 用户每次查询都由业务权限实时计算允许访问的 Source 集合；
- 跨 Source 综述只对完全相同的权限快照生成，并绑定 `aclEpoch`、`knowledgeEpoch`；
- 查询结果返回后再次按数据库权限、文档和 Scope 世代做最终 ACL 校验；
- 个人记忆只进入本人私有 Source，不进入组织或行业 Source；
- 文档/权限变化经 Outbox 进入增量同步与 Scope 失效、重编译流程；
- 每晚由 BullMQ 持久化定时任务运行 Source Dream 与 Scope Dream。

整体评价：**业务架构符合，检索主路径有效，诊断可用；仍有运维质量项需要持续治理，不能宣称所有 GBrain 内部维护阶段均为完全健康。**

## 与官方实践的对应关系

| 官方原则 | 当前实现 | 结论 |
| --- | --- | --- |
| 一个 Brain 内使用多个独立 Source | 每个有效知识库使用稳定 `llmwiki-kb-*` Source | 符合 |
| 不相关内容默认隔离，跨源查询必须显式指定 | API 只把本次授权 Source ID 传给 GBrain | 符合 |
| 多用户读取按 Source 粒度授权 | 平台权限服务计算 Source 列表，查询后数据库再复核 | 符合当前单一可信 API 场景 |
| Source 仓库是耐久事实源 | 规范化 Markdown 先写入 Git，再执行 GBrain sync | 符合 |
| 增量同步、避免每用户完整重建 | Source-centric publish；一个文档只同步一次 | 符合 |
| 检索使用混合召回、融合、图谱和重排 | balanced 模式；向量、BM25、RRF、graph signals、rerank；失败时平台重排补偿 | 符合，已增加运行诊断 |
| Compiled Truth 可重写，Timeline 保持证据轨迹 | 原始文档保留原文证据；权限 Scope 综述可重建并保存来源集合和世代 | 场景化符合 |
| Dream 可重复、可审计、定期执行 | BullMQ 每日 02:00（Asia/Shanghai）运行双级 Dream，执行结果入库 | 符合 |

官方参考：

- <https://github.com/garrytan/gbrain/blob/master/docs/tutorials/company-brain.md>
- <https://github.com/garrytan/gbrain/blob/master/docs/guides/multi-source-brains.md>
- <https://github.com/garrytan/gbrain/blob/master/docs/architecture/brains-and-sources.md>
- <https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md>
- <https://github.com/garrytan/gbrain/blob/master/docs/guides/compiled-truth.md>
- <https://github.com/garrytan/gbrain/blob/master/docs/protocol/MCP_META_CHANNELS.md>

## 本次实测证据

- 本机 GBrain 版本：`0.47.9.0`。
- 当前 6 个有效业务 Source 的数据库文档映射数与 GBrain 页面数逐一一致：`0/2/0/1/2/1`。
- 当前有效知识库共有 6 篇已发布文档；GBrain 对应有效 Source 共有 6 个可检索页面。
- Outbox 当前无 pending/failed 事件。
- 真实问答：“员工考勤办法第十条是什么内容”。
  - 5 个授权 Source 参与检索；
  - 首轮返回 5 个候选页，检测到 `weak_semantic` 后自动扩检；
  - 平台重排后证据门控保留 2 条，最终回答引用 1 个原始文档；
  - 回答准确定位第十条“旷工”的认定和处理；
  - 19 个平台处理节点完成，回答、引用和处理链均成功落库；
  - 浏览器无页面异常，无 HTTP 5xx；刷新后历史会话仍可查看同一调用链。

## 新增的逐回答调用链

每条回答现在实时产生并保存以下节点：

1. 运行时模型配置；
2. 知识权限计算；
3. GBrain Source 规划；
4. Source 新鲜度校验；
5. 历史会话消歧；
6. 检索问题改写；
7. 个人记忆检索；
8. 权限范围派生综述；
9. GBrain 混合检索；
10. 结果权限复核；
11. 弱证据扩展检索；
12. Source 对账重试；
13. 候选重排；
14. 证据收敛；
15. 主题页惰性编译；
16. 回答上下文组装；
17. 大模型流式生成；
18. 引用校验与映射；
19. 回答与诊断链路落库。

节点包含 `running/success/warning/failed/skipped` 状态、耗时、摘要和可展开反馈。敏感字段（密钥、密码、Authorization、数据库 URL）在写入和推流前过滤。异常回答也会尽力保存失败节点，便于从历史会话复盘。

GBrain 检索节点会显示本次实际模式、Source 数、缓存命中、原始候选数、去重页面数、父页补全数、原生重排是否返回分数，以及配置参与的检索阶段。当前 CLI JSON 不提供 MCP 的完整 `_meta.retrieval`，因此页面不会虚构某个 GBrain 内部子阶段的独立成功状态；内部检索栈作为一个真实节点展示，外围每个可观测步骤独立展示。

`weak_semantic` 仅作为 GBrain 的命中路径分类，不再直接等同于系统告警。聚焦查询默认以 `0.75` 为可配置扩检门槛：高分语义命中直接进入重排和证据门控，中低分语义命中执行一次广覆盖增强。只要增强成功就属于正常处理；只有无候选、扩检后仍无证据或后续恢复失败才计入告警。

## 尚需持续治理的边界

### 1. Dream 当前为 `partial`，不是失败

最近一次定时 Dream 的 sync、extract、facts、backlinks 均正常；部分 Source 因 GBrain lint 仍有 1–3 条未自动修复项而标为 partial，部分 Scope 的 `synthesize` 返回空内容后使用了确定性文档清单兜底。该状态不阻止原文检索，但应在运维页保留警告，不能显示为“全部健康”。

### 2. 历史 Source 尚有运维存量

GBrain 数据库共登记 59 个 Source，其中当前业务实际使用 6 个原始 Source，其余主要是旧版用户 Source、已归档知识库 Source 和旧 Scope 产物。由于查询始终显式传入授权 Source，这些存量不会参与当前回答；后续应先生成引用与成员影响清单，再批量 archive，不能直接删除。

### 3. 权限由平台 API 负责，不是 GBrain OAuth 独立强制

当前只有平台后端能够调用本机 GBrain，采用“查询前允许 Source 列表 + 查询后数据库 ACL”是合理且更贴合现有组织/角色动态授权的方案。如果未来允许 OpenClaw、第三方 Agent 或外部 MCP 客户端直接连接 GBrain，应增加官方 OAuth `allowedSources`，把 Source 权限同时下沉到 GBrain 服务端。

### 4. 原始文档与 Compiled Truth 的角色需区分

精确条款问题优先使用原始文档页面；广域总结问题才加入与当前权限世代一致的 Scope 派生综述。原始上传文档本身是证据页，不应在界面上统称为“Compiled Truth”。当前调用链已改用“回答上下文/原始证据/派生综述”的准确表述。

## 发布状态

本次变更只在本机测试环境构建、迁移和验收；未发布生产环境。生产发布需在用户验收并明确同意后执行。
