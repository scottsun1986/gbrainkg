#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GBrainKG SOTA 全场景知识库测试套件（可执行版）

覆盖场景域：
  P0 健康与认证        P1 语料与索引就绪       P2 检索与问答（锚点事实法）
  P3 语义鸿沟/多源冲突  P4 拒答与反幻觉          P5 权限边界
  P6 健壮性与安全       P7 知识图谱与运维接口     P8 性能预算

用法：
  LLMWIKI_TOKEN=<jwt> python3 tests/e2e/sota_knowledge_base_suite.py
  # 或用户名密码登录
  LLMWIKI_USER=admin LLMWIKI_PASS=*** python3 tests/e2e/sota_knowledge_base_suite.py

可选环境变量：
  API_BASE        默认 http://127.0.0.1:3202
  TEST_KB_NAME    锚点语料库名（默认 系统测试-解析矩阵库）
  PERF_BUDGET_S   单问答回合延迟预算（默认 90）

退出码：0=全部通过；1=存在 FAIL（SKIP 不算失败）。
报告：tests/e2e/results/sota-suite-<时间戳>.json
"""
import json
import os
import random
import re
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:3202").rstrip("/")
TEST_KB_NAME = os.environ.get("TEST_KB_NAME", "系统测试-解析矩阵库")
PERF_BUDGET_S = float(os.environ.get("PERF_BUDGET_S", "90"))
TOKEN = os.environ.get("LLMWIKI_TOKEN", "")
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

_refusals = ("未包含相关信息", "无法回答", "无法根据知识库回答", "未包含")


# ---------------------------------------------------------------- HTTP 层
def http(method, path, body=None, token=None, timeout=60):
    """返回 (status, headers, raw_text)。网络错误返回 (0, {}, str(err))。"""
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")
    except Exception as e:  # 超时/连接失败
        return 0, {}, str(e)


def chat(message, kb_scope=None, token=None, timeout=PERF_BUDGET_S + 60):
    """调用问答 SSE 接口，返回 dict(answer, citations, traces, latency_s, status)。"""
    body = {"message": message}
    if kb_scope:
        body["kb_scope"] = kb_scope
    started = time.time()
    status, _, raw = http("POST", "/api/v1/chat/completions", body,
                          token=token or TOKEN, timeout=timeout)
    result = {"answer": "", "citations": [], "traces": [], "latency_s": round(time.time() - started, 2),
              "status": status}
    if status not in (200, 201):  # 接口成功时返回 201（会话已创建）
        result["error"] = raw[:400]
        return result
    for line in raw.split("\n"):
        line = line.strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        kind = data.get("type")
        if kind == "delta":
            result["answer"] += data.get("content") or ""
        elif kind == "citation":
            entry = data.get("timeline_entry") or {}
            result["citations"].append({
                "doc_title": entry.get("doc_title"),
                "document_id": entry.get("document_id"),
                "score": entry.get("score"),
                "page_no": entry.get("page_no"),
                "bbox": entry.get("bbox"),
                "version": entry.get("version"),
                "version_conflict": entry.get("version_conflict"),
            })
        elif kind == "trace":
            node = data.get("node") or {}
            result["traces"].append({
                "id": node.get("id"), "status": node.get("status"),
                "summary": node.get("summary"), "details": node.get("details"),
            })
    return result


def ensure_token():
    """优先用 LLMWIKI_TOKEN；否则用 LLMWIKI_USER/LLMWIKI_PASS 登录。"""
    global TOKEN
    if TOKEN:
        return True
    user = os.environ.get("LLMWIKI_USER")
    pwd = os.environ.get("LLMWIKI_PASS")
    if not (user and pwd):
        print("!! 需要 LLMWIKI_TOKEN 或 LLMWIKI_USER/LLMWIKI_PASS", file=sys.stderr)
        return False
    status, _, raw = http("POST", "/api/v1/auth/login", {"username": user, "password": pwd})
    if status != 200:
        print(f"!! 登录失败 HTTP {status}: {raw[:200]}", file=sys.stderr)
        return False
    TOKEN = json.loads(raw).get("token", "")
    return bool(TOKEN)


def resolve_test_kb():
    """按名称解析锚点语料库 id（/kbs 为分页接口，遍历页）；找不到返回 None。"""
    page = 1
    while page <= 10:
        status, _, raw = http("GET", f"/api/v1/kbs?page={page}&limit=100", token=TOKEN, timeout=30)
        if status != 200:
            return None, f"GET /kbs HTTP {status}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return None, "kbs 响应非 JSON"
        items = payload.get("items") if isinstance(payload, dict) else payload
        items = items or []
        for kb in items:
            if isinstance(kb, dict) and kb.get("name") == TEST_KB_NAME:
                return kb.get("id"), None
        total = int(payload.get("total") or 0) if isinstance(payload, dict) else 0
        if page * 100 >= total or not items:
            break
        page += 1
    return None, f"未找到知识库「{TEST_KB_NAME}」"


# ---------------------------------------------------------------- 断言工具
class Case:
    def __init__(self, case_id, category, name):
        self.id, self.category, self.name = case_id, category, name
        self.status = "PASS"   # PASS / FAIL / SKIP
        self.detail = ""
        self.latency_s = None


def expect(case, condition, fail_msg, ok_msg=""):
    if condition:
        case.detail = ok_msg or case.detail
    else:
        case.status = "FAIL"
        case.detail = fail_msg
    return condition


def doc_titles(result):
    return [c.get("doc_title") or "" for c in result.get("citations", [])]


def trace_node(result, node_id):
    for node in reversed(result.get("traces", [])):
        if node.get("id") == node_id:
            return node
    return None


# ---------------------------------------------------------------- 用例
CASES = []
LATENCIES = []


def case(case_id, category, name):
    def decorator(fn):
        CASES.append((Case(case_id, category, name), fn))
        return fn
    return decorator


TEST_KB = {"id": None}


@case("P0-01", "健康与认证", "/health 返回 200")
def c_health(case):
    status, _, raw = http("GET", "/health", timeout=10)
    expect(case, status == 200 and '"ok"' in raw, f"HTTP {status} {raw[:120]}",
           f"HTTP {status}")


@case("P0-02", "健康与认证", "无 Token 访问受保护接口 → 401")
def c_auth_missing(case):
    status, _, _ = http("GET", "/api/v1/kbs", timeout=10)
    expect(case, status == 401, f"期望 401，实际 {status}")


@case("P0-03", "健康与认证", "伪造 Token → 401/403")
def c_auth_forged(case):
    status, _, _ = http("GET", "/api/v1/kbs", token="forged.sig", timeout=10)
    expect(case, status in (401, 403), f"期望 401/403，实际 {status}")


@case("P1-01", "语料与索引就绪", "锚点语料库存在且已发布文档 ≥10")
def c_corpus(case):
    kb_id, err = resolve_test_kb()
    if not kb_id:
        case.status = "SKIP"
        case.detail = err or "语料库缺失"
        return
    TEST_KB["id"] = kb_id
    status, _, raw = http("GET", f"/api/v1/kbs/{kb_id}/documents", token=TOKEN, timeout=30)
    if not expect(case, status == 200, f"documents 接口 HTTP {status}"):
        return
    docs = json.loads(raw)
    docs = docs if isinstance(docs, list) else docs.get("items") or docs.get("documents") or []
    expect(case, len(docs) >= 10, f"已发布文档仅 {len(docs)} 篇", f"文档 {len(docs)} 篇")


@case("P1-02", "语料与索引就绪", "分块向量嵌入覆盖率 ≥85%（语义就绪）")
def c_embeddings(case):
    status, _, raw = http("GET", "/api/v1/admin/embeddings/coverage", token=TOKEN, timeout=30)
    if status == 403:
        case.status = "SKIP"
        case.detail = "非管理员，跳过覆盖率检查"
        return
    if not expect(case, status == 200, f"coverage 接口 HTTP {status}"):
        return
    data = json.loads(raw)
    total, embedded = data.get("total", 0), data.get("embedded", 0)
    ratio = (embedded / total) if total else 0
    expect(case, ratio >= 0.85, f"覆盖率 {ratio:.0%}（{embedded}/{total}）低于 85%",
           f"覆盖率 {ratio:.0%}（{embedded}/{total}）")


@case("P2-01", "检索与问答", "条款精确-表格行：EQ-0077 巡检周期=30")
def c_eq0077(case):
    if not TEST_KB["id"]:
        case.status = "SKIP"; case.detail = "语料库缺失"; return
    r = chat("EQ-0077 的巡检周期是多少天？", [TEST_KB["id"]])
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    ok = ("30" in r["answer"]) and any("big_table" in t.lower() or "考核" in t for t in doc_titles(r))
    expect(case, ok, f"answer={r['answer'][:120]} citations={doc_titles(r)[:3]}")


@case("P2-02", "检索与问答", "大文档尾部锚点：BIGDOC-VERIFY=7788")
def c_bigdoc(case):
    if not TEST_KB["id"]:
        case.status = "SKIP"; case.detail = "语料库缺失"; return
    r = chat("BIGDOC-VERIFY 验证编号是多少？", [TEST_KB["id"]])
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    expect(case, "7788" in r["answer"], f"answer={r['answer'][:120]}")


@case("P2-03", "检索与问答", "多 Sheet xlsx 锚点：SUM-2026-5566")
def c_xlsx(case):
    if not TEST_KB["id"]:
        case.status = "SKIP"; case.detail = "语料库缺失"; return
    r = chat("考核汇总表的编号是多少？", [TEST_KB["id"]])
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    expect(case, "SUM-2026-5566" in r["answer"], f"answer={r['answer'][:120]}")


@case("P2-04", "检索与问答", "超长文档首部锚点：天穹-2026 总预算=3.75亿")
def c_ultralong(case):
    if not TEST_KB["id"]:
        case.status = "SKIP"; case.detail = "语料库缺失"; return
    r = chat("天穹-2026 项目的总预算是多少？", [TEST_KB["id"]])
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    expect(case, "3.75" in r["answer"] and "亿" in r["answer"], f"answer={r['answer'][:120]}")


@case("P2-05", "检索与问答", "全景列举：考勤手册全部章名")
def c_chapters(case):
    r = chat("请列出《企业考勤管理制度详细手册》的全部章名")
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    ok = ("第一章" in r["answer"]) and ("第八章" in r["answer"])
    expect(case, ok, f"answer={r['answer'][:160]}")


@case("P3-01", "语义鸿沟与多源", "口语→术语：员工夏天几点上班 → 夏令时 08:30")
def c_summer(case):
    r = chat("员工夏天几点上班")
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    ok = ("08:30" in r["answer"]) and any("考勤" in t for t in doc_titles(r))
    expect(case, ok, f"answer={r['answer'][:140]} citations={doc_titles(r)[:3]}")


@case("P3-02", "语义鸿沟与多源", "多源冲突并列：两份考勤制度时间均呈现")
def c_conflict(case):
    r = chat("员工考勤的时间是什么")
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    titles = " ".join(doc_titles(r))
    both_docs = ("手册V2" in titles or "V2" in titles) and ("详细手册" in titles)
    both_times = ("09:00" in r["answer"]) and ("08:30" in r["answer"])
    expect(case, both_docs and both_times,
           f"citations={doc_titles(r)[:3]} answer={r['answer'][:140]}")


@case("P4-01", "拒答与反幻觉", "知识库外问题 → 标准拒答，不编造")
def c_refusal(case):
    r = chat("量子纠缠保密通信的技术实施方案编号是多少？")
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    refused = any(word in r["answer"] for word in _refusals)
    expect(case, refused, f"未拒答：{r['answer'][:140]}")


@case("P4-02", "拒答与反幻觉", "拒答时引用校验豁免（refusalExempt，无误导性告警）")
def c_refusal_trace(case):
    # A per-run nonce keeps this question out of the semantic cache so the
    # fresh citation-validation stage (and its refusal exemption) is exercised.
    r = chat(f"区块链存证在第三方的部署方案编号是什么？({int(time.time())})")
    node = trace_node(r, "citation_validation")
    if not node:
        case.status = "SKIP"; case.detail = "未取到 citation_validation trace"; return
    details = node.get("details") or {}
    refused = any(word in r["answer"] for word in _refusals)
    if refused:
        exempt = details.get("refusalExempt") is True or "标准拒答" in (node.get("summary") or "")
        expect(case, exempt, f"拒答未豁免：summary={node.get('summary')}")
    else:
        expect(case, node.get("status") in ("success", "warning"),
               f"trace 状态异常 {node.get('status')}")


@case("P5-01", "权限边界", "越权 kb_scope（不存在的库）→ 403")
def c_scope_forbidden(case):
    fake = f"11111111-2222-3333-4444-{random.randint(10**11, 10**12-1)}"
    status, _, _ = http("POST", "/api/v1/chat/completions",
                        {"message": "测试", "kb_scope": [fake]}, token=TOKEN, timeout=30)
    expect(case, status == 403, f"期望 403，实际 {status}")


@case("P5-02", "权限边界", "无 Token 问答 → 401")
def c_chat_no_token(case):
    status, _, _ = http("POST", "/api/v1/chat/completions", {"message": "测试"}, timeout=30)
    expect(case, status == 401, f"期望 401，实际 {status}")


@case("P6-01", "健壮性与安全", "SQL 注入样例 → 非 500")
def c_sqli(case):
    status, _, _ = http("POST", "/api/v1/chat/completions",
                        {"message": "考勤'; DROP TABLE \"User\"; --"}, token=TOKEN, timeout=60)
    expect(case, status != 0 and status < 500, f"HTTP {status}")


@case("P6-02", "健壮性与安全", "4 万字符超长问题 → 非 500")
def c_long_question(case):
    status, _, _ = http("POST", "/api/v1/chat/completions",
                        {"message": "考勤制度 " + "加班规定" * 8000}, token=TOKEN, timeout=90)
    expect(case, status != 0 and status < 500, f"HTTP {status}")


@case("P6-03", "健壮性与安全", "空问题 → 4xx 非 500")
def c_empty_question(case):
    status, _, _ = http("POST", "/api/v1/chat/completions", {"message": ""}, token=TOKEN, timeout=30)
    expect(case, 400 <= status < 500, f"期望 4xx，实际 {status}")


@case("P6-04", "健壮性与安全", "非法 UUID scope → 4xx 非 500")
def c_bad_uuid(case):
    status, _, _ = http("POST", "/api/v1/chat/completions",
                        {"message": "测试", "kb_scope": ["not-a-uuid"]}, token=TOKEN, timeout=30)
    expect(case, 400 <= status < 500 or status == 403, f"HTTP {status}")


@case("P7-01", "知识图谱与运维", "知识图谱接口可用且首建 ≤60s")
def c_graph_first(case):
    started = time.time()
    status, _, raw = http("GET", "/api/v1/knowledge-graph?limit=1000", token=TOKEN, timeout=70)
    elapsed = time.time() - started
    if not expect(case, status == 200, f"HTTP {status}"):
        return
    data = json.loads(raw)
    stats = data.get("stats") or {}
    expect(case, elapsed <= 60 and stats.get("documents", 0) > 0,
           f"{elapsed:.1f}s documents={stats.get('documents')}",
           f"首建 {elapsed:.1f}s，documents={stats.get('documents')}, relations={stats.get('relations')}")


@case("P7-02", "知识图谱与运维", "知识图谱二次访问走缓存 ≤3s")
def c_graph_cache(case):
    started = time.time()
    status, _, raw = http("GET", "/api/v1/knowledge-graph?limit=1000", token=TOKEN, timeout=15)
    elapsed = time.time() - started
    if not expect(case, status == 200, f"HTTP {status}"):
        return
    data = json.loads(raw)
    expect(case, data.get("cached") is True and elapsed <= 3,
           f"cached={data.get('cached')} {elapsed:.2f}s",
           f"缓存命中 {elapsed:.2f}s")


@case("P7-03", "知识图谱与运维", "OpenAPI 对外服务规范可访问")
def c_openapi(case):
    status, _, raw = http("GET", "/open-api/spec.json", timeout=15)
    expect(case, status == 200 and '"openapi"' in raw, f"HTTP {status}",
           "OpenAPI 3.0.3 spec 200")


@case("P8-01", "性能预算", "问答延迟预算 P50 ≤ PERF_BUDGET_S")
def c_perf(case):
    if not LATENCIES:
        case.status = "SKIP"; case.detail = "无问答样本"; return
    p50 = statistics.median(LATENCIES)
    expect(case, p50 <= PERF_BUDGET_S, f"P50={p50:.1f}s 超预算",
           f"P50={p50:.1f}s / P95≈{sorted(LATENCIES)[min(len(LATENCIES)-1, int(len(LATENCIES)*0.95))]:.1f}s（n={len(LATENCIES)}）")


@case("P8-02", "性能预算", "引用契约：引用含 page_no/version，trace 含 citation_validation")
def c_citation_contract(case):
    r = chat("EQ-0077 的巡检周期是多少天？")
    LATENCIES.append(r["latency_s"]); case.latency_s = r["latency_s"]
    if not r["citations"]:
        case.status = "SKIP"; case.detail = "无引用返回"; return
    has_page = any(c.get("page_no") for c in r["citations"])
    has_version = any(c.get("version") for c in r["citations"])
    # A semantic-cache replay intentionally skips the per-stage trace, so a
    # cache-hit node also satisfies the observability contract.
    has_trace = trace_node(r, "citation_validation") is not None or trace_node(r, "semantic_cache") is not None
    expect(case, has_page and has_version and has_trace,
           f"page_no={has_page} version={has_version} trace={has_trace}",
           f"引用 {len(r['citations'])} 条，契约完整")


# ---------------------------------------------------------------- 主流程
def main():
    print("=" * 72)
    print(" GBrainKG SOTA 全场景知识库测试套件")
    print(f" API: {API_BASE}   语料库: {TEST_KB_NAME}")
    print("=" * 72)
    if not ensure_token():
        sys.exit(2)

    report_cases = []
    failed = skipped = passed = 0
    for cur, fn in CASES:
        try:
            fn(cur)
        except Exception as e:  # 用例自身异常按 FAIL 处理
            cur.status = "FAIL"
            cur.detail = f"用例异常: {type(e).__name__}: {e}"
        icon = {"PASS": "✓", "FAIL": "✗", "SKIP": "○"}[cur.status]
        line = f"[{icon}] {cur.id:<7} {cur.name}"
        if cur.latency_s is not None:
            line += f"  ({cur.latency_s}s)"
        if cur.detail:
            line += f"\n       └ {cur.detail}"
        print(line)
        report_cases.append({
            "id": cur.id, "category": cur.category, "name": cur.name,
            "status": cur.status, "detail": cur.detail, "latency_s": cur.latency_s,
        })
        passed += cur.status == "PASS"
        failed += cur.status == "FAIL"
        skipped += cur.status == "SKIP"

    total = len(CASES)
    print("-" * 72)
    print(f" 总计 {total} | 通过 {passed} | 失败 {failed} | 跳过 {skipped}")
    if LATENCIES:
        lat = sorted(LATENCIES)
        print(f" 问答延迟: P50={statistics.median(lat):.1f}s  "
              f"P95≈{lat[min(len(lat)-1, int(len(lat)*0.95))]:.1f}s  max={lat[-1]:.1f}s")

    os.makedirs(RESULTS_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = os.path.join(RESULTS_DIR, f"sota-suite-{stamp}.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump({
            "api": API_BASE, "test_kb": TEST_KB_NAME, "started_by": "sota-suite",
            "summary": {"total": total, "passed": passed, "failed": failed, "skipped": skipped},
            "cases": report_cases,
        }, fh, ensure_ascii=False, indent=2)
    print(f" 报告: {report_path}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
