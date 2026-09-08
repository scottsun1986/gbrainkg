# LLMWiki（GBrainKG）全格式全场景综合测试用例

> **文档编号**：GBA-TC-2026-09-08
> **版本**：v1.0
> **用途**：系统级验收/回归测试基线，覆盖多格式、多大小、复杂知识结构、检索质量、权限边界、健壮性与安全
> **执行环境**：API `http://127.0.0.1:3202` · Parser `:8100` · Web `:3200`（systemd 三服务 + Postgres/Redis/MinIO/Gitea 容器）
> **配套**：执行结果见《综合测试报告》(comprehensive-system-test-report-2026-09-08.md)

---

## 一、测试范围与策略

| 阶段 | 范围 | 方法 | 用例数 |
|---|---|---|---|
| A | 文档摄入矩阵（格式×大小×结构×异常） | API 上传 + 状态轮询 + 质量门断言 | 26 |
| B | 检索与问答质量（锚点事实法） | SSE 问答 + 关键词/引用断言 | 18 |
| C | 权限边界（三级库/组织树/授权/撤销） | 多账号可见性矩阵 + 越权尝试 | 14 |
| D | 健壮性与安全（认证/限流/注入/并发） | 边界与恶意输入 | 13 |
| E | 单元与契约测试 | Jest / pytest / 契约脚本 | 115+11+11 |
| F | 前端冒烟与性能抽样 | Playwright 截图 + 时延统计 | 6 |

**锚点事实法**：每篇测试文档在首/中/尾埋入唯一可验证的"锚点事实"（如编号、金额、日期），问答断言以锚点命中与引用文档正确性为准，避免主观评分。

---

## 二、阶段 A：文档摄入矩阵（26 用例）

### A-1 格式与结构正向用例（18）

| ID | 文件 | 大小 | 结构特征 | 预期 |
|---|---|---|---|---|
| A-01 | 01_tiny_note.md | 84B | 最小 Markdown | published/passed |
| A-02 | 02_legal_clauses.md | 30KB | 章/节/条法规结构，**故意制造条款编号跳跃/重复**（第三十一条插于第五十九条后） | **needs_review（条款连续性质量门应命中）** |
| A-03 | 03_deep_headings.md | 22KB | H1-H6 六级标题嵌套 | published |
| A-04 | 04_big_table.md | 7.6KB | 9 列×80 行宽表 + 表尾锚点行 | published，表头跨块传播 |
| A-05 | 05_mixed_charset.md | 734B | 中英混排/emoji/全角/生僻字/代码块/内嵌 HTML(script/img onerror) | published；XSS 标记仅作文本存储 |
| A-06 | 06_ultra_long_25k.md | 105KB | 20 章×5 节超长文档，首/中/尾锚点 | published |
| A-07 | 07_malformed.md | 408B | 未闭合代码围栏/畸形表格/无空格标题/断链 | published 或 needs_review（不崩溃） |
| A-08 | 10_plain_text.txt | 24KB | 300 行纯文本 | published |
| A-09 | 11_roster.csv | 21KB | 500 行 6 列花名册 + 尾部锚点注释 | published |
| A-10 | 12_product_intro.html | 576B | 标题/表格/列表/内嵌 script | published |
| A-11 | 20_regulation.docx | 38KB | 60 章 docx + 中部 12×5 表格 + 首/中/尾锚点 | published |
| A-12 | 21_large_3mb.docx | 55KB(压缩)/~2.6MB 文本 | 2600 个章节段落 | published；富化耗时长属预期 |
| A-13 | 22_assessment_2krows.xlsx | 68KB | 双 Sheet（2000 行考核 + 汇总锚点） | published |
| A-14 | 23_large_100krows.xlsx | 3.1MB | 10 万行单表 | published/needs_review |
| A-15 | 24_training_60slides.pptx | 84KB | 60 页幻灯片 + 结论页锚点 | published |
| A-16 | 30_whitepaper_12p.pdf | 14KB | 原生文本 PDF 12 页，首/中/尾页锚点 | published（pypdf 原生路径） |
| A-17 | 31_longdoc_80p.pdf | 81KB | 原生文本 PDF 80 页，第 1/40/80 页锚点 | published |
| A-18 | 41_ocr_test.png | 17KB | 含中文文字图片（环境 OCR provider=none） | needs_review/failed（无 OCR 时不幻觉） |

### A-2 异常与边界用例（8）

| ID | 文件 | 场景 | 预期 |
|---|---|---|---|
| A-19 | 40_fake_legacy.doc | 伪 .doc（zip 头+零填充，antiword 应失败） | failed/needs_review，不崩溃 |
| A-20 | 50_empty.txt | 0 字节 | failed/needs_review（快速失败） |
| A-21 | 51_whitespace.md | 纯空白 11B | failed/needs_review |
| A-22 | 52_corrupt.docx | 损坏 zip 容器 | failed/needs_review |
| A-23 | 53_corrupt.pdf | 损坏 PDF 头尾 | failed/needs_review |
| A-24 | 54_corrupt.xlsx | 损坏 zip 容器 | failed/needs_review |
| A-25 | 55_wrong_ext.exe | 扩展名白名单外 | 上传即拒（HTTP 400） |
| A-26 | 56_oversize_201mb.txt | 201MB 超限 | 上传即拒（HTTP 413） |

### A-3 断言维度

每正向用例校验：①终态正确；②qualityStatus=passed；③chunkCount>0（详情接口）；④问答链路可引用（阶段 B 验证）。
异常用例校验：①终态非 published；②qualityIssues/engine error 可解释；③负例不阻塞其他任务（**队头阻塞观察项**）；④进程无崩溃（健康检查保持 200）。

---

## 三、阶段 B：检索与问答质量（18 用例）

| ID | 问题类型 | 问题（摘要） | 断言关键词 | 期望引用文档 | 检验点 |
|---|---|---|---|---|---|
| RQ-01 | 条款精确-中部 | 激光陀螺仪标定周期？ | 45 | 02_legal | 条款文档中部锚点 |
| RQ-02 | 条款精确-尾部 | 禁飞区违规罚款？ | 10万/50万 | 02_legal | 罚则锚点 |
| RQ-03 | 时效元知识 | 施行日期与废止？ | 2026/2024 | 02_legal | 附则锚点 |
| RQ-04 | 表格行级 | EQ-0077 巡检周期？ | 30 | 04_big_table | 宽表行命中 |
| RQ-05 | 超长-首部 | 天穹-2026 总预算？ | 3.75亿 | 06_ultra_long | 首部锚点 |
| RQ-06 | 超长-中部 | API P95 要求？ | 800/99.95 | 06_ultra_long | 中部锚点 |
| RQ-07 | DOCX 表格邻域 | 特种设备检验有效期？ | 12 | 20_regulation | 中部锚点+表格 |
| RQ-08 | DOCX 尾部 | 事故责任人处理？ | 解除劳动合同/通报批评 | 20_regulation | 尾部锚点 |
| RQ-09 | PDF 首部 | 白皮书版本与密级？ | WP-2026-R9/内部公开 | 30_whitepaper | PDF 锚点 |
| RQ-10 | 长PDF中部 | 交换机主备切换时间？ | 3秒 | 31_longdoc | 80 页中部 |
| RQ-11 | PPTX | 结业考核通过线？ | 85 | 24_training | PPT 锚点 |
| RQ-12 | XLSX 双 Sheet | 汇总表编号？ | SUM-2026-5566 | 22_assessment | 多 Sheet |
| RQ-13 | 特殊字符 | ΨOmega-7 激活码？ | ΨOmega-7 | 05_mixed | 特殊字符召回 |
| RQ-14 | HTML | PRD 产品编号？ | PRD-2026-8899 | 12_product | HTML 锚点 |
| RQ-15 | CSV 行级 | EMP00077 绩效？ | A | 11_roster | CSV 行命中 |
| RQ-16 | 大 DOCX 尾部 | BIGDOC-VERIFY 号？ | 7788 | 21_large | 3MB 文档 |
| RQ-17 | 拒答 | 量子纠缠通信方案？ | （拒答词） | 无 | 不幻觉 |
| RQ-18 | 全景列举(breadth) | 列出全部章名 | 总则/飞行运行管理/检测与维护/罚则 | 02_legal | 宏观枚举能力 |

**判定规则**：PASS=关键词全命中且引用文档正确；PARTIAL=关键词命中但引用文档错/缺；FAIL=关键词未命中。RQ-17 以拒答词命中为 PASS。

---

## 四、阶段 C：权限边界（14 用例）

**环境构造**（唯一时间戳隔离，测试后可归档）：

```
组织树: 权限测试总部{TS} ├─ A组{TS}（A组组织库：机密A「北极星计划9.87亿」）
                        └─ B组{TS}（B组读者，无额外授权）
行业库: 权限测试行业库{TS}（机密IND「代号朱雀/11月」）→ 授权 A组读者(user主体)
```

| ID | 用例 | 预期 |
|---|---|---|
| PM-01 | A组读者可见 A 组组织库（组织库向下继承） | 可见 |
| PM-02 | A组读者可见被授权行业库 | 可见 |
| PM-03 | B组读者不可见 A 组组织库（同父兄弟子树隔离） | 不可见 |
| PM-04 | B组读者不可见未授权行业库 | 不可见 |
| PM-05 | A组读者问答能命中机密A | 命中 |
| PM-06 | B组读者问答查不到机密A（内容不泄露） | 不泄露 |
| PM-07 | B组读者查不到行业库机密 | 不泄露 |
| PM-08 | B组读者强制指定 A 组库 kb_scope 检索 | 403/404 拒绝 |
| PM-09 | B组读者向 A 组库上传 | 403 拒绝 |
| PM-10 | B组读者自助创建个人库并写入 | 201 成功 |
| PM-11 | A组读者不可见 B 组个人库（个人库物理隔离） | 不可见 |
| PM-12 | A组读者检索不到 B 组私人机密（BLUE-991） | 不泄露 |
| PM-13 | 撤销行业库授权后 A 组读者立即可见性消失 | 不可见 |
| PM-14 | 撤销后 A 组读者检索不到行业库机密 | 不泄露 |

---

## 五、阶段 D：健壮性与安全（13 用例）

| ID | 用例 | 预期 |
|---|---|---|
| RB-01 | 无 Token 访问 /kbs | 401 |
| RB-02 | 伪造 Token | 401 |
| RB-03 | 篡改 Token payload（换 sub/延长 exp） | 401（签名校验） |
| RB-04 | 无 Token 访问 /admin/data | 401/403 |
| RB-05 | 非法 UUID 路径参数 | 4xx 非 500 |
| RB-06 | SQL 注入样例查询参数 | 非 500 |
| RB-07 | 连续 12 次错误密码登录 | 出现 429 限流 |
| RB-08 | 空问题串 | 4xx 非 500 |
| RB-09 | 4 万字符超长问题 | 非 500 |
| RB-10 | XSS 探针文档写入（存储侧不报错；渲染侧由 DOMPurify 白名单保障） | 受理成功 |
| RB-11 | OpenAPI spec.json 可访问 | 200 JSON |
| RB-12 | Open-API 无凭证调用 | 401 |
| RB-13 | 5 并发小文档上传 | 全部受理（200/201） |

附加观察项：登录限流窗口恢复（65s 后可正常登录）；/health 全程 200。

---

## 六、阶段 E：单元与契约测试（基线）

| 套件 | 命令 | 用例数 | 基线 |
|---|---|---|---|
| API 单元测试 | `npx jest`（apps/api） | 115 | **114/115**（已知 chat.service operation 回归） |
| 解析器测试 | `PYTHONPATH=src python3 -m pytest tests/` | 11 | 11/11 |
| GBrain 适配器契约 | `packages/gbrain-adapter/run-contract.test.cjs` | 11 | 计划执行 |

---

## 七、阶段 F：前端冒烟与性能抽样

| ID | 用例 | 预期 |
|---|---|---|
| FE-01 | 登录页加载与错误密码提示 | 正常渲染、错误可见 |
| FE-02 | 正确登录进入对话屏 | 进入 chat 屏 |
| FE-03 | 知识库屏文档列表（含各状态标记） | 渲染 24+ 文档 |
| FE-04 | 知识图谱屏 | 力导向图渲染 |
| FE-05 | 管理后台（组织树/用户/模型） | 渲染正常 |
| FE-06 | 问答流式输出 + trace 折叠面板 | 流式渲染、引用面板出现 |

性能抽样：记录 B 阶段每问 latencySec（含 LLM 生成），供报告统计 P50/P95。

---

## 八、测试数据管理

- 测试知识库：`系统测试-解析矩阵库`（admin 个人库，标记"勿删"）；阶段 C 资源带时间戳 `权限测试*{TS}`，测后可经 admin API 归档清理。
- 全部产物：`/tmp/opencode/testdocs/`（生成脚本 + 测试文档 + 结果 JSON）。
- 敏感约定：测试报告不记录任何真实凭据明文。
