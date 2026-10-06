# 全面审查验证记录

2026 年 10 月 1 日，本地工作区验证，无生产发布。

| 项目 | 命令与范围 | 结果 |
| --- | --- | --- |
| 总构建与测试 | `pnpm test`，包含 API/Web build | 6 项 Turbo task 通过 |
| API 单测 | 默认关闭 RLS/授权/版本开关 | 115 suites，885 tests 通过；1 suite / 5 tests 默认跳过 |
| Web 单测 | 真实 React 结构、引用安全及工具函数 | 50 tests 通过 |
| Parser | `pnpm test:parser` | 47 tests，4 subtests 通过 |
| Adapter | `pnpm test:adapter` | 13 tests 通过 |
| 核心数据库集成 | `python3 tests/integration/run-core-checks.py --database gbrain_core_opt_test` | 版本/generation 发布与回滚、严格输出撤权序列化、差量图谱、入库覆盖、真实 RLS 矩阵通过 |
| 词法数据库集成 | 显式 `gbrain_core_opt_test`，每次独立 schema 并清理 | 5 tests 通过：稀有词排序、截断召回、KB scope/published 过滤、分词与统计一致性、幂等 |
| 配对门禁计算 | `python3 -m pytest tests/evaluation/core-flow/test_paired_gate.py -q` | 4 tests 通过；非真实质量评测 |
| 浏览器聊天 | 独立 `.next-audit` 生产构建；内存 API 与实际分段 SSE | 首屏不等待慢管理请求、同数量库更新、第一条回答反馈定位、500 错误提示、停止收尾、迟到历史隔离、移动溢出均通过，无 pageerror |
| 回答排版 | `tests/e2e/chat_answer_layout.py`，真实 React 渲染夹具 | 1440、390、320 像素及移动深色模式通过，任务 checkbox 无重复标记 |
| 全量 lint | `pnpm lint` | 初始 Web 116 errors / 149 warnings，未通过；本轮修改 ChatScreen HEAD 对照 7→6 errors、13→11 warnings，bootstrap 0 errors / 2 warnings 不变 |
| 差异空白检查 | `git diff --check` | 通过 |

浏览器延迟为单次夹具测量：管理 API 人为延迟 3000ms，主壳 2822ms 可操作，管理 API 尚未完成。不是 LCP、P95 或真实知识查询质量证据。排版最终修复单独重新运行 React 渲染与浏览器排版检查；聊天状态回归的构建在 checkbox 修复前，状态逻辑与最终代码一致。

词法集成结果另附 lexical-summary.txt。原始本地日志位于 `/tmp/gbrain-audit-*`；本目录保留简明结果及实际截图。没有执行真实供应商质量/成本评测或百万块压测，不能据此声称全球 SOTA。
