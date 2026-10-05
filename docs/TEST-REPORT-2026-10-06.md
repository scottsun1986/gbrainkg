# GBrainKG 全面测试报告

- **测试日期**：2026-10-06
- **被测基线**：`27cd327 feat(retrieval): 优化候选饱和下的低分排除机制与重排上下文增强`
- **测试类型**：静态验证 + 单元测试 + 组件/契约测试 + 评估框架自检 + 门禁链路验证 + 代码走查（缺陷导向测试设计）
- **配套文档**：[`BUG-REPORT-2026-10-06.md`](./BUG-REPORT-2026-10-06.md)（本次走查确认 133 项缺陷）
- **测试环境**：

  | 项 | 版本 |
  |---|---|
  | OS | Linux (x86_64) |
  | Node.js | v22.22.3 |
  | pnpm | 9.15.9 |
  | Python | 3.14.4 |
  | pytest | 9.1.1 |
  | ruff | 0.14.5 |
  | mypy | 1.18.2 |
  | PostgreSQL | 可用（本地容器），测试使用隔离库 |
  | Docker | 29.7.2 |

---

## 目录

1. [测试概述](#1-测试概述)
2. [测试策略设计](#2-测试策略设计)
3. [测试执行结果](#3-测试执行结果)
4. [结果汇总与覆盖率分析](#4-结果汇总与覆盖率分析)
5. [缺陷汇总](#5-缺陷汇总)
6. [测试有效性分析（缺陷逃逸归因）](#6-测试有效性分析缺陷逃逸归因)
7. [测试基础设施缺陷（本次新发现）](#7-测试基础设施缺陷本次新发现)
8. [未执行测试的覆盖缺口与风险](#8-未执行测试的覆盖缺口与风险)
9. [结论与建议](#9-结论与建议)

---

## 1. 测试概述

### 1.1 测试目的

1. 建立可信的**基线质量画像**（静态 + 单元 + 契约 + 自检全绿还是存在失败）
2. 通过**代码走查驱动缺陷导向测试**（错误推测法）发现现有测试无法捕获的缺陷
3. 评估**测试基础设施本身的有效性**——即"绿灯是否可信"
4. 输出可执行的缺陷清单与测试补强建议

### 1.2 被测对象与规模

| 被测单元 | 语言/框架 | 生产代码行数 | 测试代码行数 | 测试/生产比 |
|---|---|---|---|---|
| `apps/api` | TypeScript / NestJS 10 + Prisma 5 | 46,797 | 18,490 | 39.5% |
| `apps/web` | TypeScript / Next.js 16 + React 19 | 13,654 | 715 | 5.2% |
| `apps/parser-worker` | Python 3.10+ / FastAPI | 2,764 | 1,063 | 38.5% |
| `packages/gbrain-adapter` | TypeScript / Node CLI | 1,579 | 187 | 11.8% |
| `packages/database`（schema + 76 迁移） | SQL / Prisma | 904 + 3,669 | 0（仅 5 个手工 `verify.sql`） | 0% |
| `packages/shared-types` | TypeScript | 24 | 0 | 0% |
| `tests/`（评估框架） | Python + TypeScript | — | 69 `.py` + 16 `.ts` | — |
| **合计** | — | **≈ 69,391** | **≈ 20,455** | **29.5%** |

> 行数统计口径：生产代码为 `*.ts`/`*.tsx`/`*.py`/`*.sql`/`schema.prisma`，已排除 `node_modules`、`dist`、`.next`、构建产物、`*.spec.ts`。

### 1.3 不在本次测试范围内的部分

| 排除项 | 原因 |
|---|---|
| 需要生产凭据的在线门禁（`ci-gate.sh` 活体部分、`sota-gate.sh`、`feedback-gate.sh`、`ab-gate.sh`） | 无 `LLMWIKI_TOKEN` / `TEST_PASSWORD`，且按 AGENTS.md §1 不得触碰生产 |
| `tests/evaluation/results/` 下 638 个 JSON 结果文件 | 历史产物，非测试代码；已抽查确认其中多个是**过期/全 401 的假绿产物** |
| 性能 / 压测（`tests/evaluation/intl-benchmark/load_test.py`、`tests/evaluation/scale/`） | 需要活的 API + 100k chunk 语料 |
| 浏览器 E2E（`tests/e2e/*.py` 中的 Playwright 套件） | 需要被测 web 构建 + 活体后端 |
| `tests/e2e-web/`、`tests/evaluation/enterprise/` | **源码已丢失**，仅剩 `__pycache__` 字节码，见 §7-TI-01 |

---

## 2. 测试策略设计

### 2.1 测试理论框架

本次测试按测试层次（Testing Levels）与测试类型（Testing Types）两个正交维度组织，依据 ISTQB 标准术语：

**测试层次**

| 层次 | 定义 | 本项目对应物 |
|---|---|---|
| 单元测试 Unit Testing | 对最小可测单元（函数/类）做隔离验证，通常含桩替身 | `apps/api/**/*.spec.ts`（143 suites）、`apps/web/__tests__/*.test.ts`（9 文件）、`apps/parser-worker/tests/*.py`（9 文件）、`run-contract.test.cjs` |
| 组件测试 Component Testing | 验证封装后的组件/服务与其接口契约 | `run-contract.test.cjs`（13 例，验证 GBrain CLI 子进程契约）、`mcp.service.spec.ts`、`weknora-client.spec.ts` |
| 集成测试 Integration Testing | 验证模块间协作、含真实中间件 | `tests/integration/*`（真实 Postgres）、`lexical-index.integration.spec.ts`、`object-storage.service.spec.ts` |
| 系统测试 System Testing | 端到端验证完整系统 | `tests/e2e/sota_knowledge_base_suite.py`、`tests/functional/full_functional_suite.py` |
| 验收测试 Acceptance Testing | 验证业务目标达成 | `tests/evaluation/quality-gate.ts`、`intl-benchmark/sota10/`、`paired_gate.py` |

**测试类型**

| 类型 | 本次执行情况 | 证据位置 |
|---|---|---|
| 功能测试 | ✅ 大量执行 | 单元 + 契约 + 自检共 1,409 个用例 |
| 静态测试 / 验证（Verification） | ✅ 全量执行 | `tsc --noEmit` ×2、ESLint、ruff、mypy、`prisma validate` |
| 接口测试 | ✅ 契约层执行 | `run-contract.test.cjs`、TS 自检的 `fetch` 打桩 |
| 安全测试 | ⚠️ 仅代码走查 | 见 BUG-REPORT（H-01…H-06、C-01、C-04、M-71/M-72） |
| 性能测试 | ❌ 未执行 | 需活体 API + 语料 |
| 可靠性 / 异常测试 | ⚠️ 部分执行 | `controlled_jobs.py` 取消与超时、`bridge-rescue.spec.ts`(554 行)、`benchmark_suite --selftest` 的 401/403/5xx 分类 |
| 兼容性测试 | ❌ 未执行 | 无跨浏览器矩阵；仅 `chat_answer_layout.py` 覆盖 1440/390/320px |
| 可用性测试 | ⚠️ 仅静态 | 走查发现 M-42（失败操作静默）、M-46（假成功）、M-52/M-53（无提示） |
| 回归测试 | ✅ 执行 | `test_faithfulness_metric.py`（24 例指标回归）、`feedback-regression.ts`、`test_sota_gate_results.py`（7 例） |

### 2.2 测试设计技术

| 技术 | 应用实例 |
|---|---|
| **等价类划分** | `lexical-tokenizer.spec.ts` 按 CJK/ASCII/标识符分等价类；`beir_pipeline --selftest` 按 401/403/500/无效 JSON/传输错误分类 |
| **边界值分析** | `admin-user-response.spec.ts`、`mfa.spec.ts` 的窗口边界；`retrieval-budget.spec.ts`、`context-budget.spec.ts` |
| **判定覆盖 / 条件覆盖** | `prisma-exception.filter` 相关分支、`output-hygiene.spec.ts`、`grounding-numeric.spec.ts` |
| **错误推测（缺陷导向）** | **本次主要手段** —— 对 `env` 数值读取统一注入非法值、对比较器注入 `NaN`/字符串、对缓存注入超容量、对 guard 注入 query string 绕过假设；共反推出 88 项缺陷（详见 §6） |
| **状态转换测试** | `chat-run.service.spec.ts`、`enrichment.processor.spec.ts`（版本栅栏）、`document-acl.service.spec.ts`（inherit/restricted 双模） |
| **变形测试（Mutation）** | ❌ 未部署（无 Stryker / mutmut）—— 这正是 §6 中大量"逻辑取反"类缺陷逃逸的根因 |
| **属性测试（Property-based）** | ❌ 未部署（无 fast-check / Hypothesis）—— 排序确定性类缺陷（M-02）因此无人捕获 |
| **模糊测试（Fuzz）** | ⚠️ 仅人工构造 | `deep_bug_hunt.py` 探索性；`fetch_datasets --selftest` 测 NaN gain；`maxsim_job` 测维度拒绝 |

### 2.3 覆盖策略判定

采用**风险驱动覆盖**（Risk-Based Coverage）分层：

- **Tier 0（必测，已完成）**：静态类型 + 静态检查 + 全部单元测试 + 全部离线自检
- **Tier 1（应测，需活体环境）**：集成、系统、验收、性能 —— 本次**因环境不具备而降级为代码走查 + 缺陷预测**
- **Tier 2（规范缺失，本次识别为风险）**：安全渗透、性能基线、兼容性矩阵、可用性走查

---

## 3. 测试执行结果

### 3.1 静态验证（白盒 / 验证性测试）

| # | 检查项 | 命令 | 结果 | 说明 |
|---|---|---|---|---|
| S-1 | API 类型检查 | `pnpm --filter api exec tsc --noEmit` | ✅ **PASS** | 退出码 0，无诊断输出 |
| S-2 | Web 类型检查 | `pnpm --filter web exec tsc --noEmit` | ✅ **PASS** | 退出码 0，无诊断输出 |
| S-3 | API 代码规范 | `pnpm --filter api lint`（ESLint 8 + @typescript-eslint 6） | ✅ **PASS** | 无 error / warning |
| S-4 | Parser 代码规范 | `ruff check src tests` | ✅ **PASS** | `All checks passed!` |
| S-5 | Parser 类型检查 | `mypy --explicit-package-bases --namespace-packages main.py quality.py extractors` | ✅ **PASS** | `Success: no issues found in 5 source files` |
| S-6 | 数据库 Schema 合法性 | `prisma validate --schema=prisma/schema.prisma` | ✅ **PASS** | `The schema at prisma/schema.prisma is valid` |

> ⚠️ **S-6 只验证 schema 语法合法，不验证 76 个迁移与 schema 是否一致**（见 TI-05）、**不验证 RLS 策略是否覆盖到位**（见 BUG-REPORT M-23/M-24/M-25）。

### 3.2 单元测试

#### 3.2.1 API 服务端（`pnpm run test:api`，Jest 29 + ts-jest）

```
Test Suites: 1 skipped, 142 passed, 142 of 143 total
Tests:       5 skipped, 1235 passed, 1240 total
Snapshots:   0 total
Time:        16.336 s
EXIT=0
```

| 指标 | 值 |
|---|---|
| 测试套件文件 | 145 个 `*.spec.ts`（含 1 个条件跳过） |
| 用例总数 | 1,240 |
| 通过 | 1,235（99.6%） |
| 跳过 | 5 |
| 失败 | 0 |
| 套件跳过 | 1（`src/retrieval/lexical-index.integration.spec.ts`，见 §8-G3） |
| 执行环境 | `RLS_ENFORCE=0 CORE_AUTH_ENFORCE=0 CORE_VERSIONING_ENABLED=0 CORE_GRAPH_INCREMENTAL_ENABLED=0 LLMWIKI_ALLOW_DEV_SECRET=1` |

**⚠️ 观察到的问题**：
- Jest 输出 `A worker process has failed to exit gracefully and has been force exited. This is likely caused by tests leaking due to improper teardown.` —— 存在未清理的定时器/句柄，属测试自身资源泄漏。
- **关键**：测试命令**强制关闭了 4 个核心安全/正确性开关**（`RLS_ENFORCE`、`CORE_AUTH_ENFORCE`、`CORE_VERSIONING_ENABLED`、`CORE_GRAPH_INCREMENTAL_ENABLED`）。这意味着 RLS 强制、鉴权契约、不可变版本、增量图谱这四条最关键的生产不变量**在单元测试层面完全没有覆盖**。

#### 3.2.2 Web 前端（`pnpm --filter web test`，node:test + tsx）

```
# tests 63
# suites 26
# pass 63
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 975.860991
```

| 指标 | 值 |
|---|---|
| 测试文件 | 9 个（`api` / `stream-registry` / `markdown` / `answer-markdown` / `force-layout` / `org-utils` / `errors` / `capabilities` / `citation-phrases`） |
| 用例总数 | 63 |
| 通过 | **63（100%）** |
| 失败 | 0 |

**覆盖分布**（9 文件 / 715 行 / 63 例，对应 13,654 行生产代码）：

| 被测模块 | 用例数 | 备注 |
|---|---|---|
| `stream-registry.ts` | 13 | 并发 run 隔离、终态淘汰、轮询节奏不 busy-loop |
| `citation-phrases.ts` | 11 | 高亮短语抽取/排序 |
| `errors.ts` | 11 | 8 个类型收窄助手 |
| `answer-markdown.tsx` | 9 | SSR 标记断言 |
| `org-utils.ts` | 8 | 组织树扁平化/子树计数 |
| `markdown.ts` | 6 | 无 DOM 时 fail-closed |
| `api.ts` | 5 | SSR vs localStorage token |
| `capabilities.ts` | 5 | 权限通配符 |
| `force-layout.ts` | 4 | 力导向布局 |

**⚠️ 前端 30+ 个组件零 DOM 测试**：`ChatScreen`(1124)、`UniversalDocumentViewer`(1027)、`PptDeckViewer`(1128)、`KnowledgeGraphScreen`(777)、`PersonalSettingsScreen`(1297)、`LibrariesScreen`(805)、整个 `admin/` 树。`app-store` / `app-events` / `useAdminBootstrap` / `useToast` / `preview-api` 亦无测试。

#### 3.2.3 Parser Worker（`pnpm run test:parser`，pytest）

```
47 passed, 4 subtests passed in 1.99s
```

| 指标 | 值 |
|---|---|
| 测试文件 | 9 个 |
| 用例总数 | 47 + 4 subtests |
| 通过 | **51（100%）** |
| 失败 | 0 |

| 测试文件 | 行数 | 覆盖点 |
|---|---|---|
| `test_execute.py` | 611 | `/parse-execute` 契约 14 例：鉴权 401、PPTX 空间排序、Excel 合并单元格前向填充、DOCX 中文与伪标题、嵌入图 OCR、尺寸闸门 |
| `test_vlm_extractor.py` | 111 | 占位符→图片解析、页序优先级、不可解析占位符不抛 NameError |
| `test_extractors.py` | 82 | HTML 表格/脚本剥离、`.doc` OLE2 校验与超限前置拒绝、`/health` 报告有效能力 |
| `test_capacity.py` | 77 | `FairLimiter` 容量计数与陈旧任务清扫 |
| `test_quality.py` | 57 | 空提取拒绝、`rejected` 不被升级、PDF 页覆盖分类 |
| `test_controlled_jobs.py` | 50 | 公平性与取消、`run_process` 超时 kill |
| `test_auth.py` | 33 | `/parse/{task_id}` 需服务令牌 |
| `test_artifact_cache.py` | 30 | 实例/修订键隔离、过期与容量淘汰、磁盘失败不中断解析 |
| `test_maxsim.py` | 12 | 余弦精确值、维度与候选预算拒绝 |

**⚠️ 未覆盖**：`convert_pdf_with_fallback` / 百度 OCR token 流程 / `split_ocr_pages` / `merge_mixed_pdf_markdown` / `insert_pdf_image_placeholders` / `resource_metrics` / `metrics` —— 这些正是 BUG-REPORT 中 M-30、M-34、M-67、M-72 所在的区域。

**⚠️ 采集脆弱性**：`pyproject.toml` **未声明 `[tool.pytest.ini_options] pythonpath = ["src"]`**。实测：
```
$ cd apps/parser-worker && python3 -m pytest tests/
ERROR collecting tests/test_artifact_cache.py
E   ModuleNotFoundError: No module named 'artifact_cache'
Interrupted: 1 error during collection
!!! 44 tests collected, 1 error in 0.57s
```
只有 `pnpm run test:parser`（内含 `PYTHONPATH=src`）才能跑通。任何直接 `pytest` 的调用（IDE、开发者本地、**`.github/workflows/quality-gate.yml`**）都会在采集期失败（见 TI-02）。

#### 3.2.4 GBrain 适配器契约（`pnpm run test:adapter`，node:test）

```
# tests 13
# pass 13
# fail 0
# duration_ms 2178.066412
```

13 个契约用例全部通过，且是本仓库**质量最高的测试**——真实 spawn 子进程验证：中止真实子进程释放配额、队列中中止不 spawn、配置变更使检索缓存失效、多实例共享单一份额、联邦合并保留同名页、空结果≠协议失败、子进程输出溢出被拒、子进程失败不泄露参数与 stderr、失败读取清理去重状态无未处理 rejection、参数边界不碰撞、结构化段落只剥真实 frontmatter、`---` 分隔线不删正文、BOM/CRLF frontmatter。

#### 3.2.5 评估框架自检（`pnpm run benchmark:selftest`）

| # | 自检套件 | 命令 | 结果 |
|---|---|---|---|
| E-1 | 官方 qrels IR 指标 | `standard_ir_eval.py --selftest` | ✅ `selftest OK` |
| E-2 | 基准套件指标 | `benchmark_suite.py --selftest` | ✅ 通过 |
| E-3 | SOTA 门禁结果校验 | `unittest test_sota_gate_results.py` | ✅ **7 passed** |
| E-4 | 质量门禁鉴权 | `quality-gate-auth.selftest.ts` | ✅ `selftest OK` |
| E-5 | 质量门禁有效性 | `quality-gate-validity.selftest.ts` | ✅ **23 ok** |
| E-6 | 质量门禁 LLM 裁判 | `quality-gate-judge.selftest.ts` | ✅ `self-test passed` |
| E-7 | BEIR 管线 | `beir_pipeline.py --selftest` | ✅ `selftest OK` |
| E-8 | 数据集抓取 | `fetch_datasets.py --selftest` | ✅ `selftest OK` |
| E-9 | 压测统计 | `load_test.py --selftest` | ✅ `selftest OK` |

E-3 值得肯定：它在临时目录里用 `python3`/`docker` shim 完整 stage 了 `sota-gate.sh`，断言"过期的高分产物不能挽救一个失败探针"且"docker 从不被调用"。E-6 更进一步：它 **spawn 真实的 `quality-gate.ts` CLI 9 次**并打桩 `global.fetch`，覆盖 complete/partial/disabled/empty/empty-refusal/refusal/uncited/bad-json/bad-assertions 九种场景，断言退出码、judge 覆盖率、答案截断、judgeTrace 形状、API Key 不泄露。

**⚠️ 但 E-3/E-5/E-6/E-4 只在本地 `benchmark:selftest` 链中被覆盖**。`.github/workflows/ci.yml` 的 `evaluation` job **只跑 6 个 Python `--selftest`**（E-1/E-2/E-7/E-8/E-9 + ann_recall），**不含** E-3/E-4/E-5/E-6 —— 这 4 个 TS/unittest 套件只在 `unified-ci` job 里通过 `benchmark:selftest` 间接跑到。若有人拆掉 `unified-ci`，门禁自检会静默失去一半。

### 3.3 未被任何 CI/脚本执行的测试（本次主动补跑）

这些测试存在于仓库中但**没有任何脚本或 workflow 调用**。本次主动执行以完成测试覆盖：

| # | 测试 | 命令 | 结果 | 测试对象 |
|---|---|---|---|---|
| X-1 | 忠实度指标回归 | `pytest tests/evaluation/test_faithfulness_metric.py -q` | ✅ **24 passed** (0.06s) | CJK/ASCII 句子切分（含小数、版本号、点分名、代码围栏）、拒答检测、`judge_off → faithfulness is None`（**绝不回落为子串代理**）、judge 蕴含打分（无证据→0.0，HTTP 500/传输错误→**未测量而非 0**）、`_compute_summary` 仅对已测量项取均值 |
| X-2 | 配对门禁 | `pytest tests/evaluation/core-flow/test_paired_gate.py -q` | ✅ **4 passed** (0.49s) | 成本/延迟收益不得掩盖权限失败、真实 `latency_ms` 不被当概率、越界拒绝、`require_multihop` 需真实多跳用例 |
| X-3 | 300 文档 profile 清单 | `cd tests/evaluation/intl-benchmark && python3 -m unittest test_profile_300` | ✅ **4 passed** (1.08s) | 清单覆盖全部 gold 标题、确定性、精确 `MAX_DOCS` 数、corpus/output/dev-source/prep 的 sha256 链、KB 名冲突拒绝、299/额外/未发布均被拒、`wait_for_status` 先轮询计数再翻页、偏移翻页漂移检测 |
| X-4 | ANN 召回指标 | `ann_recall_eval.py --selftest` | ✅ `selftest OK` | `recall_at_k`、`vector_literal`、`percentile`、`parse_dsn`、`selectivity_bucket` 纯指标数学 |

> **X-1 是本次最有价值的发现之一**：该测试文件（326 行、24 例）专门防止"忠实度被降级为子串代理"这一曾经发生过的真实回归，但**从未在 CI 中执行**。同类失效模式也存在于 `test_profile_300`（因 `benchmark:selftest` 的 `unittest discover -p 'test_sota_gate_results.py'` 模式限制被排除）与 `test_paired_gate.py`（完全孤立）。

### 3.4 门禁链路验证（`scripts/ci.sh`）

#### 3.4.1 严格模式（`GATE_STRICT=1 bash scripts/ci.sh`）

| # | 门禁层 | 结果 |
|---|---|---|
| 1 | Prisma client generate | ✅ PASS |
| 2 | API typecheck | ✅ PASS |
| 3 | API lint | ✅ PASS |
| 4 | API unit tests | ✅ PASS |
| 5 | Parser worker tests | ✅ PASS |
| 6 | GBrain adapter contract tests | ✅ PASS |
| 7 | Web unit tests | ✅ PASS |
| 8 | Parser worker ruff | ✅ PASS |
| 9 | Parser worker mypy | ✅ PASS |
| 10 | Evaluation harness self-tests | ✅ PASS |
| 11 | Official-qrels IR gate | ⏭️ **SKIPPED** → `GATE_STRICT=1` 下计为失败 |
| 12 | E2E 知识库场景套件（25 例） | ⏭️ **SKIPPED** → 计为失败 |
| 13 | SOTA 检索质量门禁 | ⏭️ **SKIPPED** → 计为失败 |
| 14 | Feedback 回归门禁 | ⏭️ **SKIPPED** → 计为失败 |
| 15 | A/B 指标门禁 | ⏭️ **SKIPPED** → 计为失败 |

```
[CI] GATE_STRICT=1 summary: FAILED=1 E2E_SKIPPED=1 IR_SKIPPED=1
[CI] PIPELINE FAILED
[CI] GATE_STRICT=1: propagating non-zero exit (release must abort).
EXIT=1
```

**结论**：10/10 离线层全绿；4 个需要活体环境的层被正确识别为缺失并**拒绝放行**。这证明 `ci.sh` 的 `warn_skip` 机制工作正常 —— **前提是 `GATE_STRICT=1`**。

#### 3.4.2 默认模式下的门禁失效（**关键测试发现**）

`deploy-prod.sh:70` 的默认 `GATE_PROFILE=quality-first` 走的是 `release-quality-first-gate.sh` → `release-functional-gate.sh`，其完整检查列表为：

```
python3 tests/integration/run-core-checks.py --unit
pnpm run test:parser
pnpm run test:adapter
pnpm run benchmark:selftest
(answer-layout fixture + chat_answer_layout.py)
python3 tests/e2e/sota_knowledge_base_suite.py
git diff --check
```

**缺失**：`tsc --noEmit`、`api lint`、`test:api`、`web test`、`ci-gate.sh`、`ab-gate.sh`、`feedback-gate.sh`。

**实测影响**：一个破坏 `pnpm run test:api`、引入 TS 类型错误或 ESLint 违规的改动，只要能通过 `test:parser`/`test:adapter`/`benchmark:selftest` 与 e2e 套件，就能发布到生产并打印 `FUNCTIONAL RELEASE GATE PASSED`。而 `scripts/ci.sh:53-58` 的注释仍断言相反（"This script is the only gate deploy-prod.sh runs, and it previously executed neither"）。

**叠加放大**：`release-functional-gate.sh:33-36` 的指纹短路会把上述全部检查降级为一次 `curl /ready`：
```bash
if python3 scripts/release-gate-fingerprint.py check; then
  curl --fail --silent "${API_BASE:-http://127.0.0.1:3202}/ready" >/dev/null
  exit 0
fi
```

**门禁一致性测试（三个入口，同一门禁三套阈值）**：

| 入口 | `GATE_HIT_RATE` | `KEYWORD_COVERAGE` | `NO_HALLUCINATION` | `GATE_STRICT` |
|---|---|---|---|---|
| `gate-thresholds.sh`（声明的唯一真源） | 0.90 | 0.85 | 0.95 | — |
| `.github/workflows/ci.yml` | 0.90 | 0.85 | 0.95 | ❌ 未设 |
| `.github/workflows/quality-gate.yml` | **0.80** | **0.75** | **0.90** | ❌ 未设 |
| `quality-gate.ts` 内部默认（未被任何脚本 source 覆盖时） | **0.80** | **0.75** | **0.90** | — |

`gate-thresholds.sh:4-8, 11-12` 明确说明"环境已有值永远胜出"正是为了阻止这种分歧，但两个 workflow 都显式覆盖了它。**实测后果**：命中率 0.85 的产物在 `ci.yml` 上失败、在 `quality-gate.yml` 上通过。

**`GATE_STRICT` 缺失的后果**：`ci-gate.sh:76-84` 的 `should_run_live()` 在 `GATE_STRICT` 与 `CHECK_INTL` 均未设时打印跳过提示并 `return 1`，`LIVE_FAILURES` 保持 0，`ci-gate.sh:110` 打印 `🎯 All enabled gates passed.` 并退出 0。同时 `ci-gate.sh:26-30` 不会强制 `GATE_LLM_JUDGE=true`，于是 `quality-gate.ts:639` 打印 `Faithfulness: NOT MEASURED` 并在 `:620` 回落为关键词代理 —— 正是 `ci-gate.sh:23-25` 注释声明"绝不允许"发生的情形。**两个名为"Retrieval quality gate"的活体门禁实际从未执行过 `benchmark_suite.py --gate` 与 `ann_recall_eval.py --target-recall 0.98`。**

**`quality-gate.yml` 的 job 条件失效**：`quality-gate.yml:66` 的 `if: ${{ github.event_name == 'push' && secrets.LLMWIKI_TOKEN != '' }}`。GitHub 的 `jobs.<job_id>.if` 上下文可用性仅含 `github`/`needs`/`vars`/`inputs`，**不含 `secrets`** ⇒ `secrets.LLMWIKI_TOKEN` 求值为 null ⇒ `null != ''` 强制转换 `0 != 0` 为 false ⇒ **该 job 在任何 push 上都被跳过**。

**被声明但从未被调用的阈值**：`PROBE_TOLERANCE` 与 `GATE_NO_ANSWER_HALLUCINATION_MAX` 只被 `sota-gate.sh` / `sota_gate_results.py` 消费，而 `sota-gate.sh` **没有被任何脚本或 workflow 调用** ⇒ 注释称"该类问题在 2026-09-20/21 期间两次静默复发"的无答案幻觉率上限在 CI 与发布中**完全未强制**。

**`.github/workflows/ci.yml:152-157`** 名为 "Threshold source of truth is sourced by both gates" 的检查**只断言非空**（`test -n "$GATE_HIT_RATE"`），且所在 job 不携带 `quality-gate.yml` 的 env 块 ⇒ 上表的分歧持续存在时它依然 PASS。**该检查名断言的属性它没有测。**

### 3.5 系统 / E2E / 验收测试（未执行，含原因与替代措施）

| 套件 | 规模 | 未执行原因 | 替代措施 |
|---|---|---|---|
| `tests/e2e/sota_knowledge_base_suite.py` | 25 例（P0 鉴权/健康 … P8 延迟预算） | 需 `LLMWIKI_TOKEN` 或账号密码 | 已通过代码走查审查其 25 个场景的断言强度 |
| `tests/e2e/complex_scenario_probes.py` | 15 例（C1–C15） | 同上 | 同上 |
| `tests/e2e/verify_p0_fixes_e2e.py` / `verify_p1_p2_e2e.py` | P0/P1/P2 修复验证 | 同上，且**未被任何 CI 调用** | — |
| `tests/functional/full_functional_suite.py` | 723 行，A–H 八模块 | 需活体 API | — |
| `tests/e2e/*Playwright*.py` | 8 个脚本 | 需被测 web 构建 + 活体后端 | 走查发现 15 项前端缺陷（BUG-REPORT M-40…M-54） |
| `tests/e2e/markdown_security.py` | XSS / regex-DoS | 硬编码 `/opt/google/chrome/chrome` | 走查已确认 `lib/markdown.ts` 无可达 XSS sink |
| `tests/integration/*` | 9 文件（3 `.cjs` + 3 `.sql` + runner） | 需 `llmwiki-postgres` 容器 + 构建后 API | 走查审查了 3 个 SQL 校验脚本的断言强度 |
| `tests/evaluation/intl-benchmark/load_test.py` | 压测 | 需活体 API | — |
| `tests/evaluation/scale/` | 100k chunk 阶梯 | 需活体 PG + docker | — |
| `tests/evaluation/intl-benchmark/ann_recall_eval.py`（gate 模式） | ANN 召回 @0.98 | 需活体 PG | 纯指标自检已跑（X-4） |

---

## 4. 结果汇总与覆盖率分析

### 4.1 总体结果

| 测试层次 | 执行用例数 | 通过 | 失败 | 跳过 | 通过率 |
|---|---|---|---|---|---|
| **静态验证** | 6 项检查 | 6 | 0 | 0 | 100% |
| **单元测试 — API** | 1,240 | 1,235 | 0 | 5 | 99.6% |
| **单元测试 — Web** | 63 | 63 | 0 | 0 | 100% |
| **单元测试 — Parser** | 51 | 51 | 0 | 0 | 100% |
| **契约测试 — 适配器** | 13 | 13 | 0 | 0 | 100% |
| **评估框架自检** | 9 套（含 30 个可枚举断言 + 6 个 assert 自检） | 全部 | 0 | 0 | 100% |
| **孤立测试补跑** | 32（24 + 4 + 4） | 32 | 0 | 0 | 100% |
| **合计（可执行部分）** | **≈ 1,444** | **1,440** | **0** | **5** | **99.7%** |
| 集成测试 | ~14 | 未执行 | — | — | — |
| 系统/E2E 测试 | ~40 | 未执行 | — | — | — |
| 验收测试 | ~350 | 未执行 | — | — | — |
| 安全测试 | 0 | 未执行 | — | — | — |
| 性能测试 | 0 | 未执行 | — | — | — |

### 4.2 结论性观察

**✅ 全绿但绿得没有说服力。**

1,440 个用例 0 失败，而同期代码走查确认 **133 项缺陷（其中 5 项 CRITICAL、27 项 HIGH）**。这个反差本身就是最重要的测试有效性结论 —— 见 §6。

### 4.3 覆盖分析（按模块）

#### API 覆盖率分布（143 suites / 46,797 行）

| 模块 | 生产行数 | 占比 | spec 数 | 覆盖评价 |
|---|---|---|---|---|
| `chat/`（答案管线，**最大域**） | ~22,000 | 47% | 50 | ⚠️ **规格密集但形态单薄**：`chat.service.ts` **5,974 行零直接单测**，只由 38 个小 `.spec.ts` 间接覆盖其 20+ 个纯函数 |
| `retrieval/` | ~2,600 | 5.6% | 14 | ✅ 良好（含 242 行集成测试） |
| `admin.controller.ts` | 2,913 | 6.2% | 5 | ⚠️ 覆盖偏窄 |
| `graph-rag/` | ~3,100 | 6.6% | 7 | ✅ 良好 |
| `ingestion/` | ~5,400 | 11.5% | 15 | ✅ 良好 |
| `auth/` | ~1,700 | 3.6% | 9 | ✅ 良好（432 行 `oidc.spec.ts`） |
| `permission/` | ~1,900 | 4.1% | 7 | ✅ 良好 |
| `embedding/` | ~1,600 | 3.4% | 6 | ✅ 良好 |
| `experiments/` | ~550 | 1.2% | 7 | ✅ 良好 |
| `brain-compiler/` | ~3,400 | 7.3% | 4 | ⚠️ `brain-compiler.service.ts` **1,591 行**仅 1 个 spec（410 行） |
| `mcp/` | ~1,400 | 3.0% | 5 | ✅ 良好 |
| `raptor/` | 1,088 | 2.3% | 1 | ⚠️ 单 spec |
| `open-api/` | ~900 | 1.9% | 0 | ❌ **零测试** |
| `db/`、`storage/`、`observability/`、`redis/` | ~900 | 1.9% | 6 | ✅ 良好 |

#### 三大"覆盖充足但缺陷逃逸"的模式

| 模式 | 表现 | 逃逸的缺陷 |
|---|---|---|
| **只测纯函数，不测编排** | `chat.service.ts` 5,974 行的编排逻辑（多臂检索融合、许可重校验、流式装配、truncation）无直接测试；测试的是它调用的 50 个小工具 | H-19（索引空间混淆）、H-20（无上限串行编译）、H-23（撤权后仍可见）、M-01、M-02、M-03 |
| **只测构造，不测并发** | 所有 spec 都是单线程同步调用；无一个测试构造并发竞态 | H-12（outbox TOCTOU）、H-14（无事务多写）、M-14、M-15、M-18、M-87 |
| **只测合法输入，不测异常输入** | 几乎无测试注入 `NaN`、非数值 score、非法 env 值、超容量缓存 | M-02（NaN 排序）、M-05…M-09（M-70）（NaN 静默降级）、H-21/H-22（缓存无界） |

---

## 5. 缺陷汇总

完整清单见 [`BUG-REPORT-2026-10-06.md`](./BUG-REPORT-2026-10-06.md)。此处给出汇总视图：

| 严重级别 | 数量 | 已被现有自动化测试捕获 | **逃逸率** |
|---|---|---|---|
| CRITICAL | 5 | **0** | **100%** |
| HIGH | 27 | **0** | **100%** |
| MEDIUM | 84 | **0** | **100%** |
| LOW | 17 | **0** | **100%** |
| **合计** | **133** | **0** | **100%** |

**133 项缺陷，0 项被现有 1,440 个自动化用例捕获。**

---

## 6. 测试有效性分析（缺陷逃逸归因）

### 6.1 逃逸根因分类

| 根因 | 缺陷数（可重叠） | 机制 | 需要的测试技术 |
|---|---|---|---|
| **无变形测试** | 44 | 逻辑取反（`&&`↔`||`）、条件反转、边界±1 等变异体存活且全部通过现有断言 | Stryker / mutmut 变异测试 + 存活变异体清单 |
| **测试替身掩盖了缺陷** | 26 | mock 抹掉了真实行为：`parse_document` 的位置参数错位（C-02）在被 mock 的调用点上不可见；`planCache` 上界（H-21）在只测命中的测试里不可见 | 契约测试（真实对端）替代 mock |
| **只测纯函数，编排层无测试** | 20 | 大编排器（`chat.service.ts`、`brain-compiler.service.ts`、`retrieval-arms.ts`、`citation-assembly.ts`）无直接测试 | 编排层的场景测试 |
| **无属性测试** | 15 | 输入域只测了"正常"取值；`NaN`/字符串/超长/空 等域外输入无覆盖 | fast-check（TS）/ Hypothesis（Py） |
| **无并发测试** | 14 | 全部 spec 单线程；TOCTOU、双写、游标漂移等只在生产并发下出现 | 可控 barrier 的确定性并发测试 |
| **测试基础设施失效** | 8 | 门禁跳过 / 阈值分歧 / 脚本未被调用，使缺陷得以发布 | 见 §7（TI-01…TI-12） |
| **资源上限类缺陷** | 6 | 无任何测试验证"超过 N 项会淘汰" | 容量边界测试 |

> 单条缺陷可命中多个根因，故各行之和大于缺陷总数 133；去重后总数即 133。

### 6.2 三个具体的"测试盲区"证据

**盲区 1 — 无界缓存没有任何测试**（H-21、H-22）
`agentic-rag.service.ts` 的 `expansionCache` 有 500 条淘汰（`:338-341`），`subQueryChunkCache` 有上限（`retrieval-arms.ts:2157`），但 `planCache` 与 `scopeDomainTermsCache` 没有。**现有测试只验证缓存命中，不验证容量** ⇒ 这两个无界缓存在 1,235 个 API 用例下完全不可见。

**盲区 2 — `env` 数值读取无防御测试**（M-05…M-09、M-70）
全仓有 30+ 处 `Number(process.env.X || default)` / `int(os.environ.get(...))` 模式。其中 5 处会因拼错的配置值静默降级为无产出（`slice(0, NaN)` → 零条引用）。**没有任何测试注入非法 env 值**。建议补一个参数化测试，遍历所有数值型 env 开关，断言非法值回落默认。

**盲区 3 — 缓存击穿路径的权限过滤位置错误未被察觉**（M-04）
`subQueryChunkCache` 命中路径在 `filterQueryResultByCurrentPermission` **之前** return。当前被"每个调用方都重跑过滤"掩盖，但缓存 key 不含 `aclEpoch`。这类"靠调用方兜底的脆弱不变量"是测试盲区的典型 —— 没有测试断言"命中路径与未命中路径产生相同的过滤后结果"。

---

## 7. 测试基础设施缺陷（本次新发现）

以下 12 项是**测试与门禁自身**的缺陷，独立于业务代码。它们解释了为何 88 项业务缺陷能一路绿灯。

| ID | 严重级别 | 位置 | 缺陷 |
|---|---|---|---|
| **TI-01** | **CRITICAL** | `tests/e2e-web/`、`tests/evaluation/enterprise/` | **两个完整测试套件的源码已丢失，仅剩 `__pycache__` 字节码。** `git ls-files` 与 `git log --all` 均为空 ⇒ **从未被提交进任何分支**。从 `.pyc` 反推：e2e-web 原有 14 个用例（`test_auth` 6 / `test_permissions` 6 / `test_upload_parse_ask_chain` 2），`.pytest_cache` 的 `lastfailed` 还留着 2 个失败；enterprise 原有 4 个模块 21 个用例（`test_acceptance_gate` 6 / `test_beir_protocol` 6 / `test_invoice` 6 / `test_report` 3）。**全仓无任何引用**。其中 `test_acceptance_gate.py` 的注释明确写着"No synthetic labels"，`test_invoice.py` 覆盖"NaN/missing currency rejected、currencies kept separate"—— 都是有价值的断言，现在全部丢失。 |
| **TI-02** | **HIGH** | `.github/workflows/quality-gate.yml:23-26` vs `ci.yml:37-48, 74-76` | **同一批测试在两个 workflow 里接线方式不兼容。** `quality-gate.yml` 跑 `cd apps/parser-worker && python3 -m pytest tests/`（**无 `PYTHONPATH=src`** ⇒ 实测采集期 `ModuleNotFoundError: No module named 'artifact_cache'` 直接失败）与 `node packages/gbrain-adapter/run-contract.test.cjs`（**无 build**，而该测试 `:3` 是 `require('./dist/index.js')` 且 `dist/` 已 gitignore ⇒ 全新 runner 上必然 collection error）。`ci.yml` 正确地安装了依赖、设了 `PYTHONPATH`、先 build。 |
| **TI-03** | **HIGH** | `.github/workflows/quality-gate.yml:66` | job 条件 `if: ${{ ... secrets.LLMWIKI_TOKEN != '' }}` 在 `jobs.<job_id>.if` 中**不可用**（GitHub 上下文仅暴露 `github`/`needs`/`vars`/`inputs`）⇒ 求值为 null ⇒ 条件恒 false ⇒ **该 job 从未在任何 push 上运行过**。 |
| **TI-04** | **HIGH** | `scripts/deploy-prod.sh:70` + `release-functional-gate.sh:37-45` | **默认生产门禁不跑类型检查、lint、API 单测、Web 单测、质量门禁、A/B 门禁、反馈回归门禁**（详见 §3.4.2）。 |
| **TI-05** | **HIGH** | `20261003000000_*/verify.sql:36-45` 等 5 个 `.sql` | **FORCE RLS 不变量的唯一断言，从未被任何脚本或 workflow 执行。** 全仓 grep：`verify.sql`/`security-test.sql`/`rollback.sql` 只出现在 `docs/plans/*.md` 与 git index。`deploy-prod.sh:609` 只有 `npx prisma migrate deploy`，无后置校验。**生产当前有 3 张表处于 enabled-not-forced（`ChatRun`/`ModelQuotaBucket`/`AuthorizationState`），`prisma migrate deploy` 报成功，无人能察觉。** |
| **TI-06** | **HIGH** | `20261004120000_chat_run/verify.sql:30-33, 42-50` | 该验证脚本**无法检测它本该检测的问题**：`RAISE NOTICE 'PASS: ChatRun RLS enabled (forced=%)'` 只打印不断言；`owner_bypasses` 分支只 `RAISE NOTICE`；且检查 `current_user` 而非 `pg_class.relowner`。 |
| **TI-07** | **MEDIUM** | `20260922200000_rls_tenant_isolation/verify.sql:89-102` | 第 5 步用 `PERFORM count(*)` **丢弃结果** ⇒ 即使被 deny-all 仍打印 PASS；且文件头要求以 superuser/表属主运行（该角色永远 `rolbypassrls`）⇒ **按文档推荐的调用方式，两个 fail-closed 断言都走 SKIP 分支，脚本退出 0。** |
| **TI-08** | **MEDIUM** | `20260927100000_kb_write_rls_guard/security-test.sql:3` | 全文**未设 `\set ON_ERROR_STOP on`** ⇒ psql 默认关闭时中途报错仅打到 stderr 而**退出 0**，其后所有断言（含"Reader forged another personal owner"）全部空转。 |
| **TI-09** | **MEDIUM** | `.github/workflows/ci.yml:152-157` | "Threshold source of truth" 检查**只断言非空**，无法发现它所命名的阈值分歧。 |
| **TI-10** | **MEDIUM** | `.github/workflows/ci.yml:175-186`、`quality-gate.yml:77-90` | 两个活体门禁 job **均未设 `GATE_STRICT`** ⇒ 活体子门禁自我跳过并 `exit 0`，且 LLM judge 未强制 ⇒ 忠实度打印 `NOT MEASURED` 并回落为关键词代理。 |
| **TI-11** | **MEDIUM** | `apps/parser-worker/pyproject.toml` | **无 `[tool.pytest.ini_options] pythonpath = ["src"]`** ⇒ 只有 `pnpm run test:parser` 能跑通；任何直接 `pytest` 调用（IDE / 开发者 / `quality-gate.yml`）在采集期失败。 |
| **TI-12** | **MEDIUM** | `.github/workflows/ci.yml:139-151` vs `.github/workflows/quality-gate.yml:35-38` | `ci.yml` 的 `evaluation` job 只跑 6 个 Python `--selftest`，**不含** `test_sota_gate_results.py` 与 3 个 `quality-gate-*.selftest.ts`（合计 30 个可枚举断言）；这些只靠 `unified-ci` job 的 `benchmark:selftest` 间接覆盖，**无 job 间依赖保障**。 |

### 7.1 历史测试产物的可信度审计

抽查 `tests/evaluation/results/` 下的历史产物，确认它们**不可被误认为测量结果**：

| 文件 | 问题 |
|---|---|
| `latest_results.json`（2026-09-23） | 过期（40/220 例）；`faithfulness: 0.1125` 正是代码现已拒绝使用的**子串代理**；`keyword_hit_rate: 0.325` |
| `quality-gate-report-2026-09-27T04-02-52-146Z.json` | 50 行全部 HTTP 401，`overallSuccessRate: 0.40` —— 这正是 `quality-gate-validity.ts` 被写出来要消灭的失败模式 |
| `tests/e2e/results/p0-e2e-20261003-161020.json` | **0 字节** |
| `intl-benchmark/results/luna-fresh-20261005-161918/run-diagnostic.json` | 显式标记 `aborted_invalid_no_quality_scores`（`/chat/search` HTTP 500，89 秒延迟，运行的 dist 早于 HEAD） |

另：`quality_gate.py:102-103` 把**缺失的 nDCG 视作 `float("inf")`** ⇒ 排序门禁在排名指标缺失时被静默跳过。

---

## 8. 未执行测试的覆盖缺口与风险

### 8.1 功能覆盖缺口（按缺陷密度排序）

| 缺口 ID | 未覆盖区域 | 生产代码量 | 风险 | 关联缺陷 |
|---|---|---|---|---|
| **G-01** | `apps/web` 30+ 组件的 DOM 交互 | ~9,000 行 | 高 | M-40（重排永久空白）、M-41（引用编号错乱）、M-42（失败操作静默）、M-43（串消息状态）、M-44/M-51（轮询竞态）、M-45（丢失组织归属）、M-46（假成功）、M-47（复制无提示）、M-48（blob 泄漏）、M-50（两条命令面板项失效）、M-52/M-53（静默失败/永久卡死） |
| **G-02** | `apps/api` 编排层（`chat.service.ts` 5,974 行 / `brain-compiler.service.ts` 1,591 行 / `retrieval-arms.ts` 2,175 行 / `citation-assembly.ts` 1,411 行） | ~11,000 行 | **极高** | H-19、H-20、H-23、H-24、M-01、M-02、M-03、M-04 |
| **G-03** | PostgreSQL BM25 词法通道（`lexical-index.integration.spec.ts` 被 `LEXICAL_INDEX_INTEGRATION` 门控跳过，5 个用例） | 811 行 | 中 | — |
| **G-04** | `open-api/` 模块（`open-api.controller.ts` 646 行 + guard + 限流） | ~900 行 | **高** | H-01、H-03、H-06、L-01、L-02、L-03、M-37 |
| **G-05** | 解析器的 PDF 云 OCR 全流程（`convert_pdf_with_fallback` / token 获取 / `split_ocr_pages` / `merge_mixed_pdf_markdown` / `insert_pdf_image_placeholders`） | ~600 行 | **高** | **C-02**、M-30、M-34、M-63、M-67 |
| **G-06** | RLS 策略运行时行为（5 个 `verify.sql` / `security-test.sql` 从不执行） | 3,669 行 SQL | **极高** | C-04、M-23…M-25、M-59、M-60 |
| **G-07** | 连接器（`git` / `feishu` / `webhook`）同步游标与删除语义 | ~500 行 | 高 | M-16、M-17 |
| **G-08** | `packages/database` 迁移历史与 `schema.prisma` 的一致性 | 76 迁移 | 高 | M-26、M-27、B-5、H-15 |
| **G-09** | GBrain 适配器的进程池并发与超时（`NaN` env、`GIT_STALE_LOCK_MS`） | 1,579 行 | 中 | M-07…M-11、M-78 |
| **G-10** | `mcp/` 服务端（`mcp.service.ts` 729 行）上传与聚合路径 | ~1,300 行 | 中 | H-09、H-11、L-17 |
| **G-11** | `packages/shared-types` | 24 行 | 低 | — |
| **G-12** | `redis/`、`observability/json-logger`、`release-identity` | ~600 行 | 低 | — |

### 8.2 非功能覆盖缺口

| 类型 | 状态 | 风险 |
|---|---|---|
| **安全渗透测试** | ❌ **完全未做** | 无 SAST/DAST/依赖漏洞扫描。C-01（越权）、C-03（TLS 绕过）、C-04（RLS 关闭）、H-01（secret 落盘）、M-71/M-72（parser 鉴权范围过宽、无鉴权 `/metrics`）全部靠人工走查发现 |
| **依赖漏洞扫描** | ❌ 未做 | 无 `npm audit` / `pip-audit` / `osv-scanner` 接入 CI；`xlsx 0.20.3`（SheetJS CDN tarball）等版本固定但无扫描 |
| **性能基线** | ⚠️ 仅离线指标自检 | `load_test.py`、`scale/`、10 万 chunk 阶梯均未跑；H-26（30× 内存放大）、M-61（1 TB 并发在途）、H-27（无 LIMIT 全量物化）等资源缺陷因此未被量化 |
| **可靠性 / 混沌** | ❌ 未做 | 无故障注入；H-12（worker 崩溃后永久卡 processing）、M-36（`CancelledError` 不被捕获 ⇒ 临时文件永久残留）需混沌测试暴露 |
| **兼容性矩阵** | ❌ 未做 | 仅 `chat_answer_layout.py` 覆盖 1440/390/320px 三种宽度 + 移动端暗色；无浏览器矩阵、无 SSR/CSR 一致性矩阵（Next 16 的 `proxy.ts`/`force-dynamic` 组合尤其需要） |
| **可访问性 a11y** | ❌ 未做 | M-15（键盘焦点被 Space 劫持）、`Modal` 焦点陷阱、ARIA 标注均未验证 |
| **国际化 / 本地化** | ❌ 未做 | 中文语境假设（CJK 分词、中文正则、`zh-CN` 硬编码）未被测试；`apps/web/src/lib/citation-phrases.ts:6-11` 的硬编码中文 boilerplate 列表正是 AGENTS.md §2 关注的形态 |
| **数据迁移回归** | ⚠️ 部分 | 迁移的幂等性仅 B-11 一处被识别；无"从任意历史版本迁移到 HEAD"的端到端测试 |

### 8.3 风险矩阵

| | 已有自动化覆盖 | 无覆盖 |
|---|---|---|
| **高风险区** | 纯函数工具层（tokenizer、budget、hygiene、numeric） | **编排层、并发层、异常输入层、前端交互层、迁移与 RLS 层** |
| **低风险区** | — | `shared-types`、`redis`、少量运维脚本 |

**结论：测试投入与风险分布严重错配。** 覆盖率最高的地方（纯函数、happy path）风险最低；覆盖率最低的地方（编排、并发、异常、前端、迁移、门禁）风险最高。

---

## 9. 结论与建议

### 9.1 总体结论

| 维度 | 评价 |
|---|---|
| 静态质量 | ✅ **优秀** — 6 项静态检查全绿（双端 `tsc`、ESLint、ruff、mypy、prisma validate） |
| 单元测试执行结果 | ✅ **优秀** — 1,440 个可执行用例 0 失败 |
| 单元测试**有效性** | ❌ **严重不足** — 88 项已确认缺陷，**逃逸率 100%** |
| 集成 / 系统 / 验收覆盖 | ❌ **严重不足** — 约 404 个用例因环境不具备未执行 |
| 安全测试 | ❌ **缺失** — 5 项 CRITICAL 全靠人工走查发现 |
| 性能测试 | ❌ **缺失** — 无基线，资源缺陷未量化 |
| 门禁可信度 | ❌ **不足** — 默认发布路径不跑类型检查/lint/API 单测；4 个活体门禁自我跳过 |
| 测试基础设施 | ❌ **有缺陷** — 2 个完整套件源码丢失、2 个 workflow 接线失效、5 个 RLS 校验脚本从不执行 |

**一句话结论**：本项目的测试套件在"能不能跑通"上表现优秀，在"能不能发现问题"上存在系统性缺口。1,440 个用例 0 失败与 88 项缺陷（含 1 项普通用户越权、1 项跨租户 OCR 缓存串号、1 项生产门禁不跑类型检查）并存，说明当前测试的**主要作用是回归防护，而非缺陷探测**。

### 9.2 建议行动项（按投入产出比排序）

#### 立即（阻断性，1–2 天）

| # | 行动 | 对应缺陷 |
|---|---|---|
| A-1 | 把默认 `GATE_PROFILE` 改为 `full`，或让 `release-functional-gate.sh` 补跑 `test:api` + `tsc --noEmit` + `lint` | C-05 |
| A-2 | 两个活体门禁 job 补 `GATE_STRICT: "1"`，并删除 `quality-gate.yml` 的 7 个 `GATE_*` 覆盖与 `if` 中的 `secrets` 引用 | M-55、M-56、TI-03、TI-10 |
| A-3 | 删除 `auth.guard.ts` 的 `request.url?.includes('/admin/kbs')`；给两个 backfill 处理器补内部鉴权 | **C-01** |
| A-4 | `execute_document` 增加 `instance_id` 形参并改用关键字传参 | **C-02** |
| A-5 | 把 3 个 `verify.sql` + `rls-inspect.sh` 接进 `deploy-prod.sh` 的 `migrate deploy` 之后，`enabled_not_forced > 0` 时非零退出 | TI-05、M-23…M-25 |
| A-6 | `pyproject.toml` 加 `[tool.pytest.ini_options] pythonpath = ["src"]`；修正 `quality-gate.yml` 的 parser 与 adapter 接线 | TI-02、TI-11 |
| A-7 | 两个 workflow 补同一组阈值断言（断言具体值，而非仅非空），或干脆删除两处覆盖 | TI-09 |

#### 短期（1–2 周，补齐测试有效性）

| # | 行动 | 对应缺陷 |
|---|---|---|
| B-1 | 引入**参数化 env 合法性测试**：遍历所有数值型 env 开关，断言非法值（`NaN`/`0`/负数/空串/非数字）回落到安全默认。约 30 个开关，可用 1 个参数化用例覆盖 | M-05…M-09、M-70 |
| B-2 | 为 `planCache`、`scopeDomainTermsCache`、`subQueryChunkCache` 补**容量边界测试**（写入 N+1 项断言淘汰发生） | H-21、H-22、M-04 |
| B-3 | 引入**属性测试**（fast-check）覆盖排序确定性：`citations.sort` 在任意 score（含 `NaN`/字符串/null）下必须产出确定性顺序 | M-02 |
| B-4 | 为 `bridge-rescue`、`citation-assembly`、`fusion-rerank` 补**索引空间一致性测试**（分数序≠池序时 `isRelevant` 必须作用于目标引用） | H-19、M-01 |
| B-5 | 把 3 个孤立测试接入 CI：`test_faithfulness_metric.py`、`core-flow/test_paired_gate.py`、`intl-benchmark/test_profile_300.py`；并把 `unittest discover` 的 `-p` 模式改为覆盖全部 `test_*.py` | §3.3、X-1…X-3 |
| B-6 | 引入**变异测试**（Stryker，限 `chat/`、`permission/`、`auth/`）并把存活变异体作为待修复清单 | 26 项变异体逃逸缺陷 |
| B-7 | 为 `chat.service.ts` 的授权撤销路径补**并发测试**（生成中途撤销 ACL，断言无 delta 帧泄漏、`emitCitationsAndComplete` 被调用） | H-23 |
| B-8 | 修 `20260922200000/verify.sql:89-102`（丢弃结果）与 `security-test.sql`（缺 `ON_ERROR_STOP`） | M-59、M-60 |

#### 中期（1 个月，覆盖缺口）

| # | 行动 | 对应缺口 |
|---|---|---|
| C-1 | 为 `ConfirmModal` 建立统一的"异步操作 + 错误 toast"契约并补组件测试；为 `LibrariesScreen`/`AdminScreen`/`ChatScreen` 补轮询序列守卫测试 | M-42…M-45、M-51…M-53 |
| C-2 | 为知识图谱与文档列表补 per-document ACL 集成测试（受限文档不得出现在节点/列表中） | H-07、H-08 |
| C-3 | 为解析器补云 OCR 流程的契约测试（用 mock HTTP provider 覆盖 token 获取、`markdown_url` 校验、429 退避、超时清理、`CancelledError` 路径） | C-02、M-30、M-34、M-63、M-67 |
| C-4 | 引入 SAST（Semgrep 规则集：鉴权、RLS、secret、命令注入）+ 依赖漏洞扫描接入 CI | §8.2 安全缺口 |
| C-5 | 建立性能基线（`load_test.py` 常规化 + 100k chunk 阶梯定期跑），并对 `quality.py:45`、`chunk-embedding.service.ts:126`、Excel 网格三个点加显式内存上限 | H-26、H-27、M-61、M-31 |
| C-6 | 恢复或明确废弃 TI-01 的两个丢失套件（enterprise 的发票对账与验收门禁断言确有价值，建议重建） | TI-01 |

### 9.3 验收标准建议

修复完成后建议以以下可测条件作为验收门槛：

1. `GATE_PROFILE` 默认值下，`release-functional-gate.sh` 实际执行 `tsc --noEmit` + `lint` + `test:api` + `web test`（可用 `set -x` 输出核对）。
2. 两个活体门禁 workflow 的 `GATE_HIT_RATE` 等 7 个阈值**全部来自 `gate-thresholds.sh`**，workflow 文件中 `grep GATE_HIT_RATE` 无结果。
3. `deploy-prod.sh` 在 `migrate deploy` 后执行 `verify.sql`；人工构造一张 enabled-not-forced 表时发布被阻断。
4. 一个普通用户执行 `POST /api/v1/admin/enrichment/backfill?x=/admin/kbs`（body 含 `type:"personal"`）返回 **403**。
5. `/parse-execute` 在 mock provider 下能断言 6 个 OCR/instance 字段逐一正确送达。
6. 参数化 env 测试覆盖 ≥30 个开关；注入 `NaN` 后全部回落到默认值且有 0 个用例失败。
7. 变异测试在 `chat/`、`permission/`、`auth/` 的变异分 ≥ 80%。
8. 组件测试覆盖 `ConfirmModal` 契约：失败时弹错误 toast 且模态**不**自动关闭。

---

## 附录 A：本次执行的完整命令清单

```bash
# 静态验证
pnpm --filter api exec tsc --noEmit
pnpm --filter web exec tsc --noEmit
pnpm --filter api lint
(cd apps/parser-worker && ruff check src tests)
(cd apps/parser-worker/src && mypy --explicit-package-bases --namespace-packages main.py quality.py extractors)
pnpm --filter database exec prisma validate --schema=prisma/schema.prisma

# 单元与契约测试
pnpm run test:api                                              # 1235 passed / 5 skipped / 143 suites
pnpm --filter web test                                         # 63 passed
pnpm run test:parser                                           # 47 passed + 4 subtests
pnpm run test:adapter                                          # 13 passed

# 评估框架自检
pnpm run benchmark:selftest                                    # 9 suites
python3 tests/evaluation/intl-benchmark/ann_recall_eval.py --selftest
python3 -m unittest discover -s tests/evaluation/intl-benchmark -p 'test_sota_gate_results.py'   # 7 passed

# 孤立测试补跑（无任何 CI 引用）
python3 -m pytest tests/evaluation/test_faithfulness_metric.py -q              # 24 passed
python3 -m pytest tests/evaluation/core-flow/test_paired_gate.py -q            # 4 passed
(cd tests/evaluation/intl-benchmark && python3 -m unittest test_profile_300)   # 4 passed

# 门禁链路
GATE_STRICT=1 bash scripts/ci.sh                              # 10 PASS / 4 SKIPPED→FAIL / exit 1

# 采集脆弱性验证（预期失败）
(cd apps/parser-worker && python3 -m pytest tests/)            # ModuleNotFoundError: artifact_cache
```

## 附录 B：术语对照（ISTQB）

| 中文 | English |
|---|---|
| 验证（静态） | Verification |
| 确认（行为） | Validation |
| 单元 / 组件 / 集成 / 系统 / 验收测试 | Unit / Component / Integration / System / Acceptance Test |
| 黑盒 / 白盒 | Black-box / White-box Testing |
| 缺陷（bug）vs 失效（failure） | Defect vs Failure |
| 等价类划分 / 边界值分析 | Equivalence Partitioning / Boundary Value Analysis |
| 判定覆盖 / 条件覆盖 / 语句覆盖 | Decision Coverage / Condition Coverage / Statement Coverage |
| 变形测试 | Mutation Testing |
| 属性测试 | Property-based Testing |
| 缺陷逃逸 | Defect Escape |
| 门禁 / 发布闸门 | Gate / Release Gate |
| 假绿（门禁通过但未真正测试） | False Green |