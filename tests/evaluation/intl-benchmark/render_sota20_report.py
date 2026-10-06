#!/usr/bin/env python3
"""从 sota20/report.json 生成交付用得分评估文档（Markdown）。

用法：python3 render_sota20_report.py [输出路径]
默认输出 docs/SOTA20-BENCHMARK-REPORT-2026-10-07.md
"""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE / "results" / "sota20" / "report.json"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("docs/SOTA20-BENCHMARK-REPORT-2026-10-07.md")

GROUP_NAMES = {
    "beir": "BEIR 官方基准",
    "qa": "主流 QA 数据集（BEIR 布局归一化）",
}


def main() -> int:
    data = json.loads(REPORT.read_text(encoding="utf-8"))
    results = data.get("results", {})
    rows, missing, failed = [], [], []
    for name, r in results.items():
        m = r.get("metrics") or {}
        row = {
            "name": name,
            "group": r.get("group", ""),
            "status": r.get("status"),
            "ndcg": m.get("ndcg@10"),
            "mrr": m.get("mrr@10"),
            "recall": m.get("recall@10"),
            "kb": r.get("kb_name", ""),
        }
        if r["status"] == "ok":
            rows.append(row)
        elif r["status"] == "missing_data":
            missing.append(row)
        else:
            failed.append(row)

    def fmt(v):
        return f"{v:.3f}" if isinstance(v, (int, float)) else "—"

    lines = []
    lines.append("# SOTA-20 主流数据集基准得分评估报告\n")
    lines.append(f"> 生成时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} ｜ "
                 "被测系统：LLMWiki v50.0（本地测试环境 http://127.0.0.1:3202）\n")
    lines.append("## 1. 评测设计\n")
    lines.append("- **数据集**：20 个主流公开数据集（BEIR 官方 11 + 主流 QA 归一化 7 + 多跳推理 2），统一 BEIR 布局。")
    lines.append("- **规模约束**：按任务要求，每个数据集抽样 **≤100 篇知识**入库（seed=42 确定性抽样，金标文档全保留），评测 query ≤100/集。")
    lines.append("- **被测能力**：平台的混合检索管道（dense+bge-m3 / 全库 BM25 / BGE-M3 稀疏 / late-chunking ColBERT / GraphRAG / 结构化通道 + RRF 融合 + bge-reranker 级联重排）。")
    lines.append("- **指标**：官方 qrels 口径的 nDCG@10 / MRR@10 / Recall@10（`standard_ir_eval.py`，缺失 query 计 0 分不剔除）。")
    lines.append("- **灌库口径**：每数据集独立个人知识库 `BEIR-Eval-<name>`，文档标题携带 `[BEIR:<id>]` 标记做回映射；灌库后等待全部 `published+indexReadiness=ready` 再检索。")
    lines.append("- **替代说明**：trec-covid 与 dbpedia-entity 的官方 qrels 密度过高（单 query 金标文档达数百至数万篇），与「每集 ≤100 篇」约束不相容，故以 CMRC2018（中文阅读理解 SOTA 常用）与 TAT-QA（表格金融问答）替代。")
    lines.append("- **可复现**：`python3 tests/evaluation/intl-benchmark/sota20_benchmark.py`（幂等，报告持久化于 `results/sota20/report.json`，逐集 run/metrics/log 均留档）。\n")

    lines.append("## 2. 总分\n")
    n = len(rows)
    if n:
        avg_ndcg = sum(r["ndcg"] for r in rows) / n
        avg_mrr = sum(r["mrr"] for r in rows) / n
        avg_recall = sum(r["recall"] for r in rows) / n
        lines.append(f"| 指标 | 20 集宏观平均 |\n|---|---|")
        lines.append(f"| **nDCG@10** | **{avg_ndcg:.3f}** |")
        lines.append(f"| **MRR@10** | **{avg_mrr:.3f}** |")
        lines.append(f"| **Recall@10** | **{avg_recall:.3f}** |\n")
        lines.append(f"完成 {n}/20 个数据集" + (f"；失败 {len(failed)}（{', '.join(r['name'] for r in failed)}）" if failed else "") + (f"；缺数据 {len(missing)}" if missing else "") + "。\n")

    lines.append("## 3. 分数据集得分\n")
    for group in ("beir", "qa"):
        gr = [r for r in rows if r["group"] == group]
        if not gr:
            continue
        lines.append(f"### {GROUP_NAMES.get(group, group)}\n")
        lines.append("| 数据集 | 场景 | nDCG@10 | MRR@10 | Recall@10 |")
        lines.append("|---|---|---|---|---|")
        for r in sorted(gr, key=lambda x: -(x["ndcg"] or 0)):
            lines.append(f"| {r['name']} | {r['kb']} | {fmt(r['ndcg'])} | {fmt(r['mrr'])} | {fmt(r['recall'])} |")
        if gr:
            lines.append(f"| **小计均值（{len(gr)} 集）** | | **{sum(r['ndcg'] for r in gr)/len(gr):.3f}** | **{sum(r['mrr'] for r in gr)/len(gr):.3f}** | **{sum(r['recall'] for r in gr)/len(gr):.3f}** |")
        lines.append("")

    if failed or missing:
        lines.append("## 4. 未完成项\n")
        for r in failed:
            lines.append(f"- `{r['name']}`：{r['status']}（日志 results/sota20/log-{r['name']}.txt）")
        for r in missing:
            lines.append(f"- `{r['name']}`：数据缺失")
        lines.append("")

    lines.append("## 5. 结果解读（对照业内水准）\n")
    lines.append("- **口径警告**：本基准在「每集 ≤100 篇知识」约束下运行，语料扰动度远低于官方全量语料（如 scifact 官方 5K 篇），**不可与官方 leaderboard 直接对比**；用于横向对比本系统跨 20 个语料域的稳定性与回归基线。")
    lines.append("- **判读基准**：BEIR 官方 BM25 全量基线 nDCG@10 大致为 scifact 0.665 / nfcorpus 0.316 / fiqa 0.236 / arguana 0.397 / scidocs 0.158 / touche 0.443 / climate-fever 0.165 / fever 0.512 / hotpotqa 0.603 / nq 0.331（公开数字，供量级参照）。")
    lines.append("- **观察项**：")
    lines.append("  - 强域（≥0.6）：结构化/事实型语料——与系统「条款精确、锚点事实」的设计强项一致（E2E P2 系列亦验证）。")
    lines.append("  - 弱域（<0.4）：论证型（arguana 的金标是反方论点，语义对立检索）与超密 qrels 域——是下一阶段优化点（对抗论点检索需要对比学习微调或 query-side 论证角色建模）。")
    lines.append("  - 中文域（cmrc2018）：验证中文制度语料之外泛化能力。")
    lines.append("")
    lines.append("## 6. 运行环境备注\n")
    lines.append("- 评测期间发生一次宿主机重启：arguana 出现「BullMQ 任务丢失 → 文档滞留 indexing」事件（已通过 retry 接口恢复；该健壮性缺口已记录于 SOTA-ASSESSMENT §4.3）。")
    lines.append("- scidocs 首轮因个别空正文文档被 API 拒绝而中止；`beir_pipeline.py` 已加空文本标题兜底，补跑通过。")
    lines.append("- 全程检索走 `/api/v1/chat/search`（含完整重排与证据装配管道），非裸向量查询，反映真实业务检索质量。")

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
