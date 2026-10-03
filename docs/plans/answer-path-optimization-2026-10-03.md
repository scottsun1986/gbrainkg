# 知识问答回答路径优化设计（2026-10-03）

针对生产 inst1 的三个问题：单文档覆盖、多文档回答缺段、来源顺序错乱。本文说明根因、改动设计与验证方式。

## 一、问题 → 根因

### 1. 两份考勤制度只答了一份
`【来源 1】企业考勤制度手册V2.docx`（09:00 上班）与 `【来源 2】企业考勤管理制度详细手册.doc`（夏令时/冬令时）都在根知识库。
回答只引用了第 2 份。V2 文档从未进入候选池：top-rank 保底机制按**排名**恢复文档，V2 的分数远低于第 1 份，且标题/正文与问题词面重叠低，被剪掉。保底恢复的却是无关文档（公车管理办法、合规管理办法）。

### 2. 蕴含判定超时 → 全部暂扣语句丢失
接地门把词面不支撑的句子暂扣，收尾时批量送蕴含判定。判定用**一次调用**覆盖全部暂扣句，超时 6 秒。生产日志两次都是 `durationMs ≈ 6009`（卡在 6s 超时），判定失败返回空集，6 句全部被丢弃 → 「来源 1」小节只剩标题没有内容。

### 3. 来源 2 小节排在来源 1 之前，来源 1 下面无内容
两个原因叠加：
- 小节标题 `**来源 1《…》**` 以 `。` 结尾，被标题识别规则判为「普通句子」，进入接地门被暂扣丢弃 → 小节无标题。
- 增量流式把已核验前缀逐句下发，接地门在流式**之后**还会丢弃/重排语句，客户端看到的排版与最终答案不一致。

## 二、改动

### 1. 蕴含判定：分批并行 + 失败重试
`citation-assembly.ts`

```
judgeEntailment(statements)
  → 按 SEMANTIC_COVERAGE_BATCH_SIZE（默认 3）切片
  → 全部批次并行调用 judgeEntailmentBatch
  → 单批返回 null（HTTP 非 2xx / 超时 / JSON 解析失败）时重试一次
  → 再失败只丢本批，其余批次不受影响
```

原来一次调用 6s 超时全军覆没；现在每批 3 句、并行、最多重试一次，单次慢调用最多影响 3 句。

### 2. 跨版本对应段落补入
新文件 `version-sibling-evidence.ts`，在 `chat.service.ts` 的版本裁决**之前**调用。

```
alignSiblingEditions(citations, question, scope, guard)
  1. 查已引用文档 → 查同知识库下其他已发布版本
     （supersedesDocumentId 双向链接，或规范化标题相同）
  2. 对每条引用，在每个兄弟版本里找最相似的 chunk
     score = 0.75 × bigram Jaccard(引用, 候选) + 0.25 × 问题覆盖率
  3. 补入的 chunk 走 filterQueryResultByCurrentPermission
     （与检索证据同一套权限复核：可见知识库 + 时序效力 + 文档 ACL）
```

效果：V2 文档的对应段落（能力指标、行为指标所在 chunk）随 V1 的引用一起进入上下文。

### 3. top-rank 保底加相关性门
`bridge-rescue.ts` 的 `planTopRankGuarantee` 新增 `isRelevant` 谓词。

```
问题关键词 = extractSearchKeywords(question) 去重，长度 ≥ 2
对每个待恢复文档：标题 + 正文里命中的关键词占比 ≥ 0.2 才恢复
```

无关的公车/合规文档不再进入上下文。

### 4. 来源标签识别为标题
`ordered-answer.ts` 新增 `isSourceLabelHeading`：

```
匹配 "来源/引用/Source/Reference N" + 文档名 + 页码锚点 + 结尾标点
剥离尾部加粗标记、终端标点、页码括号（"（第 5-11 页）"）
《…》文档名 → 直接判为标题
无《》时：.doc/.pdf 等扩展名 → 标题；短名词短语 → 标题；含谓词 → 普通句子（仍走接地门）
```

`一、迟到一小时的处理` 这类纯文本标题也已支持（上一轮已加）。

### 5. 空小节标题移除
`ordered-answer.ts` 新增 `dropEmptySectionHeadings`：

```
逐行扫描；标题与下一个标题之间若全是空行或纯角标行 → 移除该标题
代码围栏内的行永不视为标题（围栏标记 + 长度跟踪，与 scanLines 一致）
```

在 `tidyVerifiedAnswer` 中调用，因此最终落库答案不留空小节。

### 6. 默认缓冲输出 + replace 事件
`answer-stream.ts`

```typescript
// 默认关闭增量流式
export function incrementalStreamingEnabled(): boolean {
  return !strictOutputEnabled() && process.env.KNOWLEDGE_INCREMENTAL_STREAM === '1';
}
```

理由：接地门在流式之后运行，会丢弃/重排语句，流式下发的前缀不是最终答案。最终质量优先于首字延迟。

同时保留 opt-in 路径的正确性：客户端开启增量后，若最终答案与已下发内容不一致，服务端在 `finishFinal` 后额外下发 `type: 'replace'` 事件携带权威全文；`ChatScreen.tsx` 收到后替换（非追加）累积文本。

### 7. 多源回答提示词规则
`chat.service.ts` 静态系统规则第 5 条改为【多源覆盖与对比完整呈现】，要求：
- 两份以上资料相关时，先声明覆盖份数，再为每份建 `**来源 N《文档名》**` 小节
- 小节按来源编号**升序**排列
- 每节必须有实质内容，禁止空小节

## 三、验证

```
API 全量 jest   1082 passed / 0 failed（130 suites）
新增/更新 spec   entailment-batching (5), version-sibling-evidence (4),
                 ordered-answer multi-source (5), answer-stream defaults (3),
                 bridge-rescue relevance gate (2)
Web 测试       41 passed
tsc --noEmit   api + web 均干净
```

未在真实数据上复跑这两个生产问题。

## 四、已知边界

- 跨版本对齐依赖 `supersedesDocumentId` 或同库同规范化标题；标题差异极大的两版（如 `管理办法` vs `手册V2`）仍可能漏配。
- 相关性门用词面关键词，对同义改写的问题可能误剪（可通过 `RETRIEVAL_TOP_RANK_MIN_TERM_COVER=0` 放宽）。
- `replace` 事件只对新版客户端生效；旧客户端在增量模式下仍会看到前缀。
- 未提交、未发布。