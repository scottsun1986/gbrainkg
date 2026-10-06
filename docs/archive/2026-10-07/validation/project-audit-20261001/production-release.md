# 生产发布记录

2026-10-01，用户明确要求“发布生产”，并在功能门禁失败后两次明确要求
“忽略门禁直接发布”。按照该指令执行：

```bash
bash scripts/deploy-prod.sh --target=all --skip-gate --skip-build
```

复用此前已构建、经过单元/数据库集成/浏览器回归的产物，没有把功能门禁标记为通过。
本次两个实例在 2026-10-01 23:45:26（Asia/Shanghai）全部发布完成，脚本退出码 0。

| 实例 | 入口 | 数据库 | Redis DB | 发布前快照 |
| --- | --- | --- | --- | --- |
| inst1 | https://knowledge.5gsailor.com:20080/ | llmwiki（现存实例 1 数据库） | 0 | /data/llmwiki/.releases/20261001154207 |
| inst2 | https://knowledge.5gsailor.com:20081/ | llmwiki_inst2 | 1 | /data/llmwiki-inst2/code/.releases/20261001154419 |

隔离检查、数据盘快照、冻结锁文件依赖安装、数据库架构检查、运行角色权限校准、
原文快照检查、服务重启及发布后健康检查均按原发布脚本执行。数据库没有待应用的
Prisma 迁移。共享解析器继续使用单一服务。

## 发布后验证

- 两个公网 HTTPS 入口从开发机使用正常 TLS 校验访问，均返回 HTTP 200。
- 两个 API `/ready` 均为 ready，保留 quality-first 配置；授权、不可变版本、增量图谱、
  自适应检索启用，sparse/MaxSim/late chunking 保持关闭。
- 两个 API 的运行指纹均匹配本次本地编译产物：
  `a1cac71831ad0da7077ddb2f74e0d7a4ba92ec16780c391565f85ecc9bc71fce`。
- 两个 Web 的 BUILD_ID 均为 `B6ALQ0PueKDwMnhSR4rze`。
- 两个 API/Web 及共享 parser 服务均 active，检查时 NRestarts=0。
- 两个实例未登录调用问答均返回 HTTP 401，未创建测试会话。
- 发布脚本的 GBrain sources status 检查通过。

## 已知未通过项

首次默认门禁在测试环境发现：完整章节列举等待约 187 秒后没有答案；不限定语料的
多源冲突用例没有返回两份预期文档和两组时间。随后中止默认发布，生产尚未同步。
上述失败没有被修复或解释为通过；用户明确要求跳过门禁后才执行本次直接发布。
生产发布后的验证为版本、服务、公网和认证健康检查，没有重新验证这两个问答场景，
也没有宣称 SOTA 质量或性能达标。

GBrain 迁移过程还输出 shared-skills 目录/写入协议告警；状态检查成功，但该告警
不等同于已完成 shared-skills 功能回归。

回滚可使用原脚本及各自快照：

```bash
bash scripts/deploy-prod.sh --rollback 20261001154207 --target=inst1
bash scripts/deploy-prod.sh --rollback 20261001154419 --target=inst2
```

本次按构建产物指纹标识发布。开发工作区中的历史文档删除未恢复，生产同步按脚本
排除 docs 目录，未把这些删除当作本次产品改动。


## 2026-10-02 后续修复状态

章节列举和多源冲突已在测试环境修复并通过默认全库回归，见[修复与验证记录](outline-conflict-fix-2026-10-02.md)。本批修复已于 2026-10-02 再次发布生产，详情见下节；上述记录为 2026-10-01 的历史发布。

## 2026-10-02 完整验收后发布

用户明确授权“验收构建然后部署测试环境，发布生产环境”。测试 API/Web 已更新、重启并验证。正常 quality-first 发布门禁通过，未使用 --skip-gate；运行 `bash scripts/deploy-prod.sh --target=all`，两个实例在 06:25:38 CST 全部发布成功。

- 构建、API 919 项、Web 52 项、Parser 47 项及 4 子测试、Adapter 和基准工具自检通过。5 项词法集成测试按原配置默认跳过。
- PostgreSQL 真实版本切换、替换入库、权限撤销及 RLS 集成检查通过。
- 真实全场景 25/25 项全部通过，零跳过，含章节列举、多源冲突、拒答、权限及引用；详见 release-final-regression-20261002.json。
- 桌面、390px 明/暗主题和 320px 排版验证通过，表格无横向溢出，数据及引用顺序正确。
- 两个 API/Web 运行版本匹配最终本地产物；TLS 公网首页 HTTP 200、API ready、未登录问答 HTTP 401；4 个 API/Web 及共享 parser 均 active。
- 两实例数据库和 Redis 保持隔离，共享中间件未复制；Prisma 71 项迁移无待应用项。

API 指纹：`26893ee5536d7aac16af0a2af749df80151abba5f8e1f76ee7e9c99f922cb423`。Web BUILD_ID：`iI9RRfw_SBubCeiIS6OSa`。

回滚快照：inst1 `/data/llmwiki/.releases/20261001222228`；inst2 `/data/llmwiki-inst2/code/.releases/20261001222439`。

现存 GBrain shared-skills 0.53.0 迁移仍有 db_only_export_required / PARTIAL 告警，属于共享技能宿主导出待办；状态检查通过，未声称此功能已经迁移完整。生产验收覆盖版本、认证和服务健康；真实问答质量回归在测试环境完成。

## 2026-10-02 09:43 条件计数修复发布

用户明确要求发布测试与生产。本批先修复再验收，正常 quality-first 门禁通过后使用 `scripts/deploy-prod.sh --target=all` 发布，未跳过门禁。两个实例于 09:43:29 CST 发布成功。

改动：
- 标题召回成为独立 RRF 排名通道；明确文件名前缀匹配得到通用结构加权；重排输入包含文件名，避免表格正文不含标题词而丢失目标文件。
- 明确命名的表格条件计数读取当前发布版本的完整不可变 Markdown。模型仅提取类型化筛选条件，代码执行精确计数；保留严格/包含边界并使用大整数定点比较，不由模型猜数量。
- 读取前后、模型请求前及输出前均核验权限，引用绑定完整原文。条件不明确、版本不存在或原文不完整时不猜测。答案明确列出实际列名及筛选口径。

验收：API 120 套件 / 927 项、Web 52 项通过，5 项词法集成测试按原配置默认跳过；真实数据库、Parser、Adapter、基准工具及四种屏幕排版检查通过。真实标准回归 25/25，零跳过；报告 table-count-release-suite.json。

测试环境真实入库：同一打分表超过90得1条、90分及以上得7条、超过99得0条；原文引用和保存后会话复核均通过。部分文件名搜索目标表格排第1。见 table-count-live-regression.json 与 table-count-title-search.json。

生产发布后：两个 API/Web 版本与最终本地构建一致，TLS 公网 HTTP 200、API ready，四个 API/Web 及共享 Parser 均 active。已实际使用 szq 登录实例1，在全部可见知识库中查询原问题，正确返回1条，AI谛听产品小组，95分；引用为《息壤杯团队打分表.xlsx》，保存后的历史消息也通过原文/权限复核。详细记录 table-count-production-postchecks.json。

API 指纹：`dd9405d4f9c5c1428640c04c88ed6a3fae19d19a1896ec2974cfc4717cb89943`。Web BUILD_ID：`HXrr_2_K-cv1oFj7cmNlN`。szq 查询耗时：26.64 秒；统计覆盖率：1。

回滚快照：inst1 `/data/llmwiki/.releases/20261002014013`；inst2 `/data/llmwiki-inst2/code/.releases/20261002014227`。

既有 GBrain shared-skills 宿主导出待办仍存在，本次未扩展该迁移范围。


## 2026-10-02 条件解析重试稳定性修复

再次查询出现旧提示，日志确认原问题在 11:22:33 触发 Invalid predicate（requestId 70e37700-9d18-4773-8b0d-36c146d9c466），并非原文缺失。该次原始模型 JSON 未记录，不能断言是哪一个字段导致；受控探针返回了有效字符串计划。校验器对等价 JSON 数字值、索引字符串、精确唯一列名和比较符号过严，可稳定复现误拒绝。

修复统一规范化等价表示，仍拒绝不安全数字、未知列/运算符、问题外阈值和错误比较边界。仅缓存已验证计划，键包含用户、不可变版本、原文哈希、完整问题及模型配置，最多 200 条且有效期 10 分钟；每次查询仍读取当前授权原文、重新计数、核验权限和引用。解析服务异常与条件不明确采用不同提示与诊断字段。

验收：API 120 套件 / 929 项、Web 52 项通过；正常 quality-first 发布门禁通过，真实全场景 25/25，零失败/跳过，含章节列举与多源冲突，见 table-count-contract-release-suite.json。真实数据库、Parser、Adapter 与四种视口排版检查通过。

本地真实入库原问题连续 5 次均返回 1 条（AI谛听产品小组，95 分），耗时 2.37–4.29 秒；严格超过90、90分及以上、超过99分别得到1、7、0，原文引用及保存后的会话复核通过。见 table-count-repeat-regression.json 与 table-count-live-regression.json。

两个实例于 11:43:05 CST 发布成功。两个 API/Web 版本匹配最终本地产物，TLS 公网首页 HTTP 200，四个 API/Web 及共享 Parser 均 active。实际使用 szq 登录实例1、选择全部可见知识库连续查询原问题5次，均返回1条：AI谛听产品小组，95分，引用《息壤杯团队打分表.xlsx》，保存后的历史回答均通过复核。耗时：[18.14, 7.68, 8.17, 8.22, 7.67] 秒。见 table-count-contract-production-postchecks.json。

API 指纹：`903a0713f7c5b46dd4028a366b40ffee7ed5d5cea9906d448d98ad143099d847`。Web BUILD_ID：`OXsHIW_blJUso0vtgIj14`。回滚快照：inst1 `/data/llmwiki/.releases/20261002033955`；inst2 `/data/llmwiki-inst2/code/.releases/20261002034204`。


## 2026-10-02 无分隔符计数问法修复

实际使用 szq 查询“息壤杯团队相关软件研发中心打分超过90的有几支队伍。”，发布前回答只有另一支95分队伍的部门排除和表格备注，没有给出数量。链路没有 table_count，grounding_gate 拦截了3句。旧规则把第一个逗号前整段当作标题；无逗号时会把全部条件当成文件名，无法进入完整原文确定性计数。见 table-count-wording-before.json。

修复：对最多80字的候选问题生成去重的连续4字标题片段，在用户所选知识库的已发布文档中召回最多101条；以实际标题与问题的最长连续共享片段匹配（至少4字且覆盖标题至少60%），只有唯一匹配且候选集未截断时才进入完整表格计数，随后继续原有文档ACL、不可变版本、条件校验、精确计数和引用复核。无部门/赛事专用别名或业务加权，亦不要求逗号或固定语序。回答缓存版本升级为v6，避免复用旧失败回答。

本地 API 120 套件/931项、Web52项通过。真实表格回归：用户新原话、部门前置换序和旧原话均返回1条（AI谛听产品小组95分），无逗号90分及以上问法返回7条，均有完整计数覆盖、原文引用和保存后历史核验。见 table-count-wording-live-regression.json。

正常 quality-first 发布门禁通过：真实全场景 25/25，零失败、零跳过，包含章节列举、多源冲突、拒答、权限及引用。真实数据库、Parser、Adapter 和四种视口检查通过。见 table-count-wording-release-suite.json。使用标准 scripts/deploy-prod.sh --target=all 发布，没有跳过门禁。

两个实例于12:22:24 CST成功发布；API/Web版本匹配本地最终产物，公网HTTP200、API ready，4个API/Web及共享Parser均active。szq选择全部可见知识库，用用户新原话连续查询5次均为1条，明确列出AI谛听产品小组95分，原文XLSX引用与保存后历史回答均通过。耗时[26.77, 12.0, 7.07, 7.12, 7.42]秒。部门前置问法也为1条，无分隔符90分及以上问法为7条。见 table-count-wording-production-regression.json 与 table-count-wording-production-health.json。

API指纹：`95d71d69010af385f5a0d63fc84ea73074470f71047534908bbdbe41bf74ffca`；Web BUILD_ID：`CheB0D4eawteJcpYhA5KZ`。回滚快照：inst1 `/data/llmwiki/.releases/20261002041948`，inst2 `/data/llmwiki-inst2/code/.releases/20261002042129`。
