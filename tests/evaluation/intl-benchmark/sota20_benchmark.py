#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SOTA-20 数据集统一基准编排器。

对 20 个主流公开数据集（统一 BEIR 布局，每个 ≤100 篇知识）逐一执行：
  1. 建独立评测知识库（BEIR-Eval-<name>）
  2. beir_pipeline 灌库（[BEIR:<id>] 标题保回映射）→ /chat/search 检索 → TREC run
  3. standard_ir_eval 以官方 qrels 计算 nDCG@10 / MRR@10 / Recall@10
产出汇总报告 tests/evaluation/intl-benchmark/results/sota20/report.json + .md。

用法：python3 sota20_benchmark.py [--datasets a,b,c] [--workers 4]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = "http://127.0.0.1:3202"
OUT = HERE / "results" / "sota20"
# 新建 KB 需等应用层可见性缓存（PERMISSION_CACHE_TTL_MS=5s）过期
KB_VISIBILITY_WAIT_S = 10
BEIR_DIRS = {
    "beir": Path("/home/scottsun/beir-data"),
    "qa": Path("/home/scottsun/qa-data"),
}
# 20 个主流数据集（来源分组：BEIR 官方 / QA 归一化 / 多跳原始集归一化）。
# 注：trec-covid 与 dbpedia-entity 的官方 qrels 密度过高（单 query 金标文档数百篇），
# 与"每个数据集 ≤100 篇知识"的评测约束不相容，改用 CMRC2018（中文阅读理解）与
# TAT-QA（表格金融问答）两个主流数据集替代。
DATASETS = [
    ("scifact", "beir"), ("nfcorpus", "beir"), ("arguana", "beir"),
    ("scidocs", "beir"), ("fiqa", "beir"), ("quora", "beir"),
    ("webis-touche2020", "beir"),
    ("climate-fever", "beir"),
    ("fever", "beir"), ("nq", "beir"), ("hotpotqa", "beir"),
    ("triviaqa", "qa"), ("squad", "qa"), ("boolq", "qa"),
    ("pubmedqa", "qa"), ("msmarco", "qa"),
    ("cmrc2018", "qa"), ("tatqa", "qa"),
    ("2wiki", "qa"), ("musique", "qa"),
]


def http(method, path, body=None, token=None, timeout=60):
    req = urllib.request.Request(f"{API}{path}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def login() -> str:
    st, raw = http("POST", "/api/v1/auth/login",
                   {"username": "admin", "password": "admin123"})
    assert st == 200, f"login {st}"
    return json.loads(raw)["token"]


def ensure_kb(token: str, name: str) -> str:
    page = 1
    created = False
    while page <= 20:
        st, raw = http("GET", f"/api/v1/kbs?page={page}&limit=100", token=token)
        if st != 200:
            break
        payload = json.loads(raw)
        items = payload.get("items") if isinstance(payload, dict) else payload
        for kb in items or []:
            if kb.get("name") == name:
                return kb["id"]
        total = int(payload.get("total") or 0) if isinstance(payload, dict) else 0
        if page * 100 >= total or not items:
            break
        page += 1
    st, raw = http("POST", "/api/v1/kbs/personal",
                   {"name": name, "description": f"SOTA-20 基准评测库 {name}"}, token=token)
    assert st in (200, 201), f"create kb {name}: {st} {raw[:200]}"
    payload = json.loads(raw)
    created = True
    kb_id = payload.get("id") or payload.get("knowledgeBase", {}).get("id")
    if created:
        time.sleep(KB_VISIBILITY_WAIT_S)
        deadline = time.time() + 60
        while time.time() < deadline:
            st, _ = http("GET", f"/api/v1/kbs/{kb_id}/documents", token=token)
            if st == 200:
                break
            time.sleep(3)
    return kb_id


def run_cmd(cmd: list[str], log: Path) -> int:
    with log.open("w") as f:
        return subprocess.call(cmd, stdout=f, stderr=subprocess.STDOUT)


def kb_ready_count(token: str, kb_id: str) -> int:
    from urllib.parse import quote
    st, raw = http("GET",
                   f"/api/v1/kbs/{kb_id}/documents?status=published&indexReadiness=ready"
                   f"&search={quote('[BEIR:', safe='')}&page=1&limit=1", token=token)
    if st != 200:
        return -1
    return int(json.loads(raw).get("total") or 0)


def reset_kb(token: str, kb_id: str) -> None:
    http("DELETE", f"/api/v1/kbs/personal/{kb_id}", token=token)


def evaluate_dataset(name: str, group: str, token: str, top_k: int = 100) -> dict:
    ddir = BEIR_DIRS[group] / name
    if not (ddir / "corpus.jsonl").exists():
        return {"dataset": name, "group": group, "status": "missing_data"}
    doc_count = sum(1 for _ in (ddir / "corpus.jsonl").open(encoding="utf-8"))
    kb_name = f"BEIR-Eval-{name}"
    kb_id = ensure_kb(token, kb_name)
    ready = kb_ready_count(token, kb_id)
    if 0 <= ready < doc_count:
        # 半灌状态：清库重灌，避免部分语料造成召回偏低
        if ready > 0:
            reset_kb(token, kb_id)
            time.sleep(KB_VISIBILITY_WAIT_S)
            kb_id = ensure_kb(token, kb_name)
        need_ingest = True
    else:
        need_ingest = False
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_out = OUT / f"run-{name}.jsonl"
    manifest_out = OUT / f"manifest-{name}.json"
    metrics_out = OUT / f"metrics-{name}.json"
    log = OUT / f"log-{name}.txt"
    if run_out.exists():
        run_out.unlink()
    cmd = [sys.executable, str(HERE / "beir_pipeline.py"),
           "--dataset-dir", str(ddir), "--api-base", API,
           "--user", "admin", "--password", "admin123",
           "--kb-id", kb_id,
           "--limit-docs", "100", "--limit-queries", "40",
           "--top-k", str(top_k),
           "--run-out", str(run_out),
           "--readiness-timeout", "1800"]
    if need_ingest:
        cmd += ["--ingest", "--manifest-out", str(manifest_out)]
    elif manifest_out.exists():
        cmd += ["--manifest-out", str(manifest_out)]
    rc = run_cmd(cmd, log)
    if rc != 0:
        return {"dataset": name, "group": group, "status": "pipeline_failed",
                "kb_id": kb_id, "log": str(log)}
    # 2) 官方 qrels 评分
    rc = run_cmd([sys.executable, str(HERE / "standard_ir_eval.py"),
                  "--qrels", str(ddir / "qrels" / "test.tsv"),
                  "--run", str(run_out), "--k", "10",
                  "--output", str(metrics_out)], log.with_suffix(".eval.log"))
    if rc != 0 or not metrics_out.exists():
        return {"dataset": name, "group": group, "status": "eval_failed",
                "kb_id": kb_id, "log": str(log)}
    metrics = json.loads(metrics_out.read_text())
    return {"dataset": name, "group": group, "status": "ok", "kb_id": kb_id,
            "kb_name": kb_name, "metrics": metrics, "ts": stamp}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", help="逗号分隔子集")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    token = login()
    wanted = set(args.datasets.split(",")) if args.datasets else None
    report_path = OUT / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {"results": {}}
    for name, group in DATASETS:
        if wanted and name not in wanted:
            continue
        if report["results"].get(name, {}).get("status") == "ok":
            print(f"[skip] {name} already ok")
            continue
        print(f"[bench] {name} ({group}) ...", flush=True)
        started = time.time()
        res = evaluate_dataset(name, group, token)
        res["wall_s"] = round(time.time() - started, 1)
        report["results"][name] = res
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        m = res.get("metrics", {})
        print(f"[done] {name}: {res['status']} "
              f"ndcg@10={m.get('ndcg@10', m.get('ndcg_cut_10'))} "
              f"mrr@10={m.get('mrr@10')} recall@10={m.get('recall@10')} "
              f"({res['wall_s']}s)", flush=True)
    ok = [r for r in report["results"].values() if r["status"] == "ok"]
    print(f"[summary] {len(ok)}/{len(report['results'])} datasets evaluated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
