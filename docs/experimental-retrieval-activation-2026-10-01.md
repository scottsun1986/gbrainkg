# 效果优先检索启用记录（2026-10-01）

用户已授权：本机测试及生产 inst1、inst2 启用受现有服务支持的能力，后续默认发布沿用；不提供额外服务器，相关能力可以不启用。

## 配置

统一配置为 `scripts/config/knowledge-quality-first.env`。默认 `deploy-prod.sh` 采用 quality-first 门禁，并原子更新目标实例独立配置文件；保留凭据并保存私有配置备份。

| 能力 | 配置 | 状态 |
| --- | --- | --- |
| 权限实时复核 / RLS | CORE_AUTH_ENFORCE=1 / RLS_ENFORCE=1 | 启用 |
| 不可变版本与索引代际发布 | CORE_VERSIONING_ENABLED=1 | 启用 |
| 增量图谱写入与依赖撤销 | CORE_GRAPH_INCREMENTAL_ENABLED=1 | 启用 |
| 自适应检索 | ADAPTIVE_RETRIEVAL_ENABLED=true | 启用，quality-first 预算 |
| BGE-M3 稀疏表示 | BGE_M3_HYBRID_ENABLED=false | 供应商不支持，关闭 |
| 多向量 MaxSim | BGE_M3_MAXSIM_ENABLED=false | 供应商不支持，关闭 |
| Late Chunking | BGE_M3_LATE_CHUNKING_ENABLED=false | 无相应服务，关闭 |

继续使用现有密集向量、全文检索、GraphRAG 及 Reranker，不新增服务器或重复中间件。

## 兼容性修复

1. 历史不可变块保留原 ID 和原版本，另外保存经过原文件跨度与 SHA256 校验的原文快照；不把索引增强文本当原文，不修改已经发布的块。快照读写受 RLS 及不可变触发器保护。
2. 修复替换入库的空 updateMany 导致误判过期，以及嵌入写入时误更新不可变块元数据。真实数据库验证旧版在新版准备期间可用，新版完成全部向量后切换。
3. 现有托管嵌入没有不可变模型权重 revision。显式采用 `ALLOW_UNVERSIONED_EMBEDDING_PUBLICATION=true`：每个新版本重新生成向量，禁止以未知 revision 复用跨版本模型缓存；不伪造 revision。ready 报告 fresh-per-version 策略。
4. 重排分数缺少匹配的留出集校准，置信度保持未知。效果优先模式不因未知概率直接拒答，也不因缺少校准重复扩检；已授权原文进入逐句 grounding，空证据仍拒答，实际低校准分仍执行门禁。
5. 回答缓存按用户、权限/知识世代、来源集合、模型及检索配置隔离，旧配置缓存不会绕过新检索链。
6. 普通短问题采用 standard 起步，候选及探测预算可升级至 deep。检索预算 60/90 秒，保留总模型调用/token 上限；生成不受已结束的检索计时取消。

7. 修复将暂扣拒答误认为空响应而重复发起 answer-only 重试的问题；拒答只输出一次，不再附加重试生成的无关资料摘要。

## 验收与发布

执行中：只有全部本机功能门禁通过后，才按已授权范围发布两个生产实例。后续补记实际测试报告、生产快照及复核结果。

## 已知边界

没有官方 qrels、完整配对精度/成本或 A/B 数据，不宣称 SOTA 指标已达标。效果优先扩大召回预算，可能增加耗时和 token。现有模型服务没有公开不可变权重版本，不支持安全的跨版本嵌入/LLM 提取缓存复用；增量图谱数据库协调仍启用。生产继续使用原文件目录后端，没有配置 MinIO；未新增服务器。
