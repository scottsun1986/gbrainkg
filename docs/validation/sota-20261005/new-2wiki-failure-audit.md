# 当前默认知识库多跳检索失败桶（2026-10-05）

本报告审计 2026-10-05 的两个已保存 retrieval-only run：2Wiki 100 题和 Hotpot 100 题。未请求模型或 API；唯一外部状态检查是使用现有本地连接对数据库执行只读查询，没有记录任何连接凭据。逐题分类、哈希、title coverage 和 bootstrap 结果见 [JSON 记录](./new-2wiki-failure-audit.json)。

这些结果使用默认运行知识库（2Wiki 770 篇、Hotpot 1000 篇源 corpus），run 的 `profile` 与 manifest/hash 字段为空；**不是 profile=300**。因此不能把 Hotpot 的 0.90 与 profile=300 的 0.99 当作同条件回归，也不在这里解释为模型变化。检索汇总为：2Wiki R@10=0.7075、full evidence=0.39；Hotpot R@10=0.95、full evidence=0.90。这里的 R@10 是所有 gold support titles 的文档级覆盖率；full evidence 是题目所有 gold titles 同时检索到的比例。保存的逐题 full-evidence 标记与按存档 top20 title 重算完全一致。

## 先核验语料，再归因

**2Wiki 当前 KB 的可检索 gold 文档齐全。** 本地只读数据库快照中 KB 有 770/770 篇 `published + ready` 文档，均有 chunk；与本地 benchmark corpus 的 770 个唯一标题逐一对应。100 题共 262 个 gold-title 实例，262 个当前均有 `published + ready` 文档和 chunk。因此这批失败不能归因于 gold 文档未入库或索引尚未 ready。100 题中 39 题 top20 覆盖全部支持文档，61 题至少缺一个 gold title；该完整覆盖率的逐题 bootstrap 95% CI 为 0.29–0.48。

**Hotpot 当前 KB 也覆盖所有本轮 gold 文档。** 数据库快照中 1001 行均为 `published + ready` 且有 chunk；1000 篇源 corpus 的全部 1000 个唯一标题均存在。200/200 个 gold-title 实例可用，90/100 题 top20 完整覆盖，10 题不完整（95% CI 0.84–0.95）。较早的 `hotpot_ingest_meta.json` 记录了 400 次 429 和超时，但本轮审计时同一 KB ID 的数据库状态已全部 published/ready；这份旧 ingest 日志不能证明本轮 10 题的 gold 文档缺失。当前 DB 比 1000 篇源 corpus 多 1 行，是 `Constantin Medien` 的重复标题；它不是本轮任何题的 gold，且没有出现在这 100 题的 top20 结果中。运行产物未冻结/写入文档 readiness 快照，所以这里的数据库状态是审计时快照，不冒充运行开始时的逐文档 manifest。

## 失败分布和重复 chunk

| 集合 | 题型/支持跳数 | 全部 gold 在 top20 | 缺至少一个 gold | 95% bootstrap CI |
|---|---|---:|---:|---:|
| 2Wiki | 2-hop（69题） | 37/69 | 32/69 | 0.42–0.65 |
| 2Wiki | 4-hop（31题） | 2/31 | 29/31 | 0.00–0.16 |
| Hotpot | bridge/hard（85题，2支持标题） | 75/85 | 10/85 | 0.81–0.94 |
| Hotpot | comparison/hard（15题，2支持标题） | 15/15 | 0/15 | 1.00–1.00 |

2Wiki 按题型也有清晰差异：`bridge_comparison` 仅 2/31 全支持标题在 top20；`compositional` 为 15/45；`comparison` 为 14/14；`inference` 为 8/10。失败主因是**文档已就绪但相关支持文档没有一起进入 top20，且 4-hop 最明显**。本轮只有检索输出，没有答案生成；不据此判断答案正确性、合成能力或引用质量。

top20 有 32 个重复 document-id 排名位置（2Wiki，28/100 题出现）和 13 个（Hotpot，7/100 题出现）；每个重复位置对应不同的 chunk ID，即多个 chunk 来自同一文档，不是同一 chunk ID 被重复返回。2Wiki 的 12 个不完整题、Hotpot 的 1 个不完整题出现这类重复位置。压缩为 unique-document 顺序后，2Wiki 只有 2 个已检索到的 gold title 名次前移，Hotpot 没有 gold title 前移；两组均没有任何题因去重而从不完整变成完整。**重复 chunk 消耗排名位是可见的效率问题，但当前存档不足以把 top20 缺证据因果归给它**：artifact 只留 top20，不能观察去重后本可能进入 cutoff 的第21名以后候选；同时所有 gold 的可用性已经核实。

最多五个可复核例子：

- 2Wiki bridge/comparison，qid `9068d246089911ebbd77ac1f6bf848b6`：4个 gold titles 均已就绪；top20 命中两部影片，缺少两位导演文档；没有重复 document slot。
- 2Wiki bridge/comparison，qid `f4cc9d4908b311ebbd86ac1f6bf848b6`：4个 gold titles 均已就绪；top20 命中两部影片，缺少两位导演文档；有1个重复 document slot，当前去重没有补回缺失导演。
- 2Wiki compositional，qid `abb7ff860bdc11eba7f7acde48001122`：两个 gold titles 均已就绪；top20 命中电影页，未命中导演 Max Mack；没有重复 slot。
- Hotpot bridge/hard，qid `5a7613c15542994ccc9186bf`：两个 gold titles 均 ready；top20 命中 VIVA Media，未命中法律实体名对应文档；没有重复 slot。
- Hotpot bridge/hard，qid `5ae199305542997b2ef7d20e`：两个 gold titles 均 ready；top20 命中 Comic Book Girl 19，未命中 Savannah College of Art and Design；有1个重复 document slot，但去重没有补回缺失标题。

## 可验证的后续检查

1. 对 2Wiki 的 29/31 个 4-hop 失败题保存完整 top50 文档 ID、title、chunk ID 和分数，并与 gold support titles 做 per-hop 对照；先确认缺失桥接证据是否只是在排名中靠后，避免先调整回答生成。
2. 在离线重评分里按 document ID 去重后再截断 cutoff，同时保留原 chunk ranking；比较 2Wiki/Hotpot 的 full-evidence 与 gold rank shift。当前证据只支持“有重复位置”，不支持“重复导致这些失败”。
3. 拆分 2Wiki `bridge_comparison`、`compositional`、`comparison`、`inference`，按支持文档数报告 R@10 和 full-evidence；本轮 4-hop 结果可作为首要排序诊断桶。
4. reconcile Hotpot ingest manifest 与当前 KB：核对为何 KB 有 1001 行、1 个重复标题，而旧 ingest meta 留有 400 个 429。重复项当前不是 gold、也没进 top20，但需要让后续 run 存下不可变的语料清单/hash 与 published/ready 快照。
