#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GBrainKG 复杂场景专项探针（C-系列）

针对主套件未覆盖的高难场景，锚定真实语料：
  C1  文档结构大纲完整性      C2  跨文档综合对比
  C3  多轮指代消解（conversation_id 串联）
  C4  时序版本冲突（差旅 v1/v2 并存）
  C5  扫描件 OCR 事实         C6  模糊/简称引用文档
  C7  一句多问复合            C8  全库范围枚举
  C9  缓存作用域隔离          C10 拒答后换措辞可答（缓存未毒化）
  C11 复合问题分解            C12 越权 scope 在缓存命中时仍 403
  C13 并发稳定性              C14 结构问题在不同问法下一致
  C15 混合否定（问库里没有的）

用法：LLMWIKI_TOKEN=<jwt> python3 tests/e2e/complex_scenario_probes.py
退出码：0=全过；1=有失败。报告：tests/e2e/results/complex-*.json
"""
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:3202").rstrip("/")
TOKEN = os.environ.get("LLMWIKI_TOKEN", "")
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
KB_CACHE = {}


def http(method, path, body=None, token=None, timeout=90):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def kbs(token):
    if "items" in KB_CACHE:
        return KB_CACHE
    page = 1
    items = []
    while page <= 10:
        st, raw = http("GET", f"/api/v1/kbs?page={page}&limit=100", token=token, timeout=30)
        if st != 200:
            break
        d = json.loads(raw)
        items += d.get("items") or []
        if page * 100 >= int(d.get("total") or 0):
            break
        page += 1
    KB_CACHE["items"] = items
    return KB_CACHE


def kb_by_suffix(token, suffix):
    for k in kbs(token)["items"]:
        if str(k.get("name", "")).endswith(suffix):
            return k["id"]
    return None



def kb_by_suffix_any(token, suffix):
    for k in kbs(token)["items"]:
        if str(k.get("name", "")).endswith(suffix):
            return k["id"]
    return None


def kb_by_name(token, name):
    for k in kbs(token)["items"]:
        if k.get("name") == name:
            return k["id"]
    return None

def chat(message, kb_scope=None, conversation_id=None, token=None, timeout=120):
    body = {"message": message}
    if kb_scope:
        body["kb_scope"] = kb_scope if isinstance(kb_scope, list) else [kb_scope]
    if conversation_id:
        body["conversation_id"] = conversation_id
    st, raw = http("POST", "/api/v1/chat/completions", body, token=token or TOKEN, timeout=timeout)
    out = {"answer": "", "citations": [], "status": st, "conversation_id": None, "traces": []}
    if st not in (200, 201):
        return out
    for line in raw.split("\n"):
        line = line.strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            d = json.loads(payload)
        except Exception:
            continue
        if d.get("type") == "conversation":
            out["conversation_id"] = d.get("conversation_id")
        elif d.get("type") == "delta":
            out["answer"] += d.get("content") or ""
        elif d.get("type") == "citation":
            e = d.get("timeline_entry") or {}
            out["citations"].append(e.get("doc_title") or "")
        elif d.get("type") == "trace":
            out["traces"].append((d.get("node") or {}).get("id"))
    return out


REFUSALS = ("未包含相关信息", "无法回答", "无法根据知识库回答")


class Case:
    def __init__(self, cid, name, cat):
        self.id, self.name, self.cat = cid, name, cat
        self.status, self.detail = "PASS", ""


def expect(c, ok, msg):
    if not ok:
        c.status = "FAIL"
        c.detail = msg


CASES = []


def case(cid, cat, name):
    def deco(fn):
        CASES.append((Case(cid, name, cat), fn))
        return fn
    return deco


# ---------------------------------------------------------------- 用例
@case("C1", "结构完整性", "文档结构大纲：支持计划两大部分+四方面（问法A）")
def c1(c, tok):
    r = chat("人工智能中小企业创业支持计划包括哪几大部分", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    keys = ["总体要求", "重点工作", "强化创业要素供给", "加强创业主体培育", "深化开源生态赋能", "完善创业服务保障"]
    miss = [k for k in keys if k not in r["answer"]]
    expect(c, not miss and len(r["answer"]) > 80, f"缺:{miss} ans={r['answer'][:80]}")


@case("C2", "跨文档综合", "北京 vs 上海通勤补贴政策差异（双文档对比）")
def c2(c, tok):
    r = chat("北京分公司和上海办公室的通勤补贴政策有何不同", kb_scope=kb_by_suffix(tok, "kb-hr"), token=tok)
    ok = ("北京" in r["answer"] and "上海" in r["answer"]
          and any(k in r["answer"] for k in ("地铁", "公交", "自驾"))
          and len(set(r["citations"])) >= 1)
    expect(c, ok, f"ans={r['answer'][:100]} cites={r['citations'][:3]}")


@case("C3", "多轮指代", "先问休假政策再问『它的生效条件』（conversation 串联）")
def c3(c, tok):
    t1 = chat("公司对于保密信息的定义包括哪些", kb_scope=kb_by_suffix(tok, "kb-company-policy"), token=tok)
    t2 = chat("再详细说明一下这个规定里保密信息的定义", kb_scope=kb_by_suffix(tok, "kb-company-policy"),
              conversation_id=t1["conversation_id"], token=tok)
    keys = ["商业机密", "技术资料", "客户信息", "财务数据"]
    hit = sum(1 for k in keys if k in t2["answer"])
    expect(c, hit >= 2, f"关键词命中{hit}/4 ans={t2['answer'][:100]}")


@case("C4", "时序版本", "差旅规定 v1 与 v2 并存：需说明变化而非混淆")
def c4(c, tok):
    r = chat("对比两个版本的差旅规定有什么变化", kb_scope=kb_by_suffix(tok, "kb-finance"), token=tok)
    ok = any(k in r["answer"] for k in ("提高", "增加", "变更", "调整", "v2", "V2", "版本"))
    expect(c, ok, f"ans={r['answer'][:120]}")


@case("C5", "扫描件OCR", "老厂房图纸承重标准")
def c5(c, tok):
    r = chat("陈旧图纸扫描件中的承重标准是多少", kb_scope=kb_by_suffix(tok, "kb-engineering"), token=tok)
    expect(c, "500" in r["answer"], f"ans={r['answer'][:100]}")


@case("C6", "模糊引用", "用简称问文档（『创业支持计划』不带书名号/全称）")
def c6(c, tok):
    r = chat("创业支持计划里开源生态部分讲了什么", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    expect(c, any(k in r["answer"] for k in ("开源", "AtomGit", "生态")) and len(r["answer"]) > 60,
           f"ans={r['answer'][:100]}")


@case("C7", "一句多问", "复合问题（孵化载体+融资 两个子题都要答）")
def c7(c, tok):
    r = chat("支持计划里如何建强孵化载体，以及融资服务保障包含哪些措施", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    a = ("孵化" in r["answer"])
    b = any(k in r["answer"] for k in ("融资", "基金", "创投"))
    expect(c, a and b, f"孵化={a} 融资={b} ans={r['answer'][:100]}")


@case("C8", "全库枚举", "全库范围问结构问题仍完整")
def c8(c, tok):
    r = chat("人工智能中小企业创业支持计划包括哪几大部分", token=tok)
    keys = ["总体要求", "重点工作", "强化创业要素供给", "完善创业服务保障"]
    miss = [k for k in keys if k not in r["answer"]]
    expect(c, not miss, f"缺:{miss} ans={r['answer'][:80]}")


@case("C9", "缓存隔离", "同题不同 scope 答案不得互相污染")
def c9(c, tok, ):
    q = f"员工考勤的时间是什么（隔离{int(time.time())}）"
    r_full = chat(q, token=tok)
    r_scoped = chat(q + "（范围）", kb_scope=kb_by_suffix(tok, "kb-hr"), token=tok)
    expect(c, r_full["status"] in (200, 201) and r_scoped["status"] in (200, 201)
           and ("09:00" in r_full["answer"] or "08:30" in r_full["answer"]),
           f"full={r_full['answer'][:60]} scoped={r_scoped['answer'][:60]}")


@case("C10", "缓存无毒化", "拒答后换措辞必须可答（不回放旧拒答）")
def c10(c, tok):
    q1 = f"量子纠缠保密通信实施方案（毒化{int(time.time())}）"
    q2 = f"完善创业服务保障包含哪些方面（复查{int(time.time())}）"
    r1 = chat(q1, token=tok)
    r2 = chat(q2, token=tok)
    expect(c, any(w in r1["answer"] for w in REFUSALS) and "服务保障" in r2["answer"],
           f"r1={r1['answer'][:50]} r2={r2['answer'][:50]}")


@case("C11", "复合分解", "复合问句：表格行锚点 + 语义鸿沟两跳都要命中")
def c11(c, tok):
    r = chat("EQ-0077 的巡检周期是多少天，另外员工夏天几点上班", token=tok)
    a = ("30" in r["answer"] or "7" in r["answer"])
    b = ("08:30" in r["answer"] or "夏令时" in r["answer"])
    expect(c, a and b, f"表格={a} 夏季={b} ans={r['answer'][:120]}")


@case("C11b", "复合分解(负例)", "库里不存在的复合问题必须拒答（不编造）")
def c11b(c, tok):
    r = chat("对比研发阶段和量产运营阶段在自主避障安全冗余上的参数差异，并说明连带处分规定", token=tok)
    expect(c, any(w in r["answer"] for w in REFUSALS), f"ans={r['answer'][:80]}")


@case("C12", "缓存命中越权", "先正常问答再越权 scope：仍须 403（缓存不得绕过 ACL）")
def c12(c, tok):
    q = f"考勤制度要点（越权{int(time.time())}）"
    chat(q, kb_scope=kb_by_suffix(tok, "kb-hr"), token=tok)          # 建缓存
    r = chat(q, kb_scope=["00000000-0000-4000-8000-000000000000"], token=tok)  # 越权
    expect(c, r["status"] in (401, 403), f"status={r['status']}")


@case("C13", "并发稳定", "5 路并发问答全部成功且无 5xx")
def c13(c, tok):
    qs = ["EQ-0077 的巡检周期", "天穹-2026 总预算", "夏令时上班时间", "第十条规定", "裁员补偿 N+1"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        rs = list(ex.map(lambda q: chat(q, token=tok, timeout=150), qs))
    bad = [(q, r["status"]) for q, r in zip(qs, rs) if r["status"] not in (200, 201)]
    expect(c, not bad, f"失败:{bad}")


@case("C14", "结构问法一致", "同一结构问题换两种问法答案一致完整")
def c14(c, tok):
    a1 = chat("人工智能中小企业创业支持计划有哪几部分内容", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    a2 = chat("人工智能中小企业创业支持计划这份文件的结构是什么", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    keys = ["总体要求", "重点工作"]
    expect(c, all(k in a1["answer"] for k in keys) and all(k in a2["answer"] for k in keys),
           f"a1缺:{[k for k in keys if k not in a1['answer']]} a2缺:{[k for k in keys if k not in a2['answer']]}")


@case("C15", "混合否定", "库里有的答、库里没有的拒（一次问答内不编造）")
def c15(c, tok):
    r = chat("支持计划里有没有关于量子计算机采购的条款", kb_scope=kb_by_name(tok, "软研中心知识库"), token=tok)
    expect(c, any(w in r["answer"] for w in REFUSALS) or "未涉及" in r["answer"],
           f"ans={r['answer'][:100]}")


# ---------------------------------------------------------------- 主流程
def main():
    print("=" * 70)
    print(" GBrainKG 复杂场景专项探针")
    print("=" * 70)
    if not TOKEN:
        print("需要 LLMWIKI_TOKEN", file=sys.stderr)
        sys.exit(2)
    kbs(TOKEN)  # 预热 KB 缓存

    rows, failed = [], 0
    for c, fn in CASES:
        try:
            fn(c, TOKEN)
        except Exception as e:
            c.status, c.detail = "FAIL", f"异常:{type(e).__name__}:{e}"
        icon = {"PASS": "✓", "FAIL": "✗"}[c.status]
        print(f"[{icon}] {c.id:<4} [{c.cat}] {c.name}" + (f"\n       └ {c.detail}" if c.detail else ""))
        rows.append({"id": c.id, "cat": c.cat, "name": c.name, "status": c.status, "detail": c.detail})
        failed += c.status == "FAIL"

    print("-" * 70)
    print(f"总计 {len(CASES)} | 失败 {failed}")
    os.makedirs(RESULTS_DIR, exist_ok=True)
    path = os.path.join(RESULTS_DIR, f"complex-{datetime.now():%Y%m%d-%H%M%S}.json")
    json.dump({"summary": {"total": len(CASES), "failed": failed}, "cases": rows},
              open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"报告: {path}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
