#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段B：检索与问答质量测试（基于阶段A锚点事实文档）"""
import json, time
from pathlib import Path
import os
import requests

API = "http://127.0.0.1:3202"
ADMIN = {"username": os.environ.get("TEST_ADMIN_USER", "admin"),
         "password": os.environ.get("TEST_ADMIN_PASSWORD", "")}  # 凭据经环境变量注入,不入库
RESULTS = Path("/tmp/opencode/testdocs/results")

def login():
    return requests.post(f"{API}/api/v1/auth/login", json=ADMIN, timeout=15).json()["token"]

def chat(token, message, kb_scope=None, timeout=120):
    body = {"message": message}
    if kb_scope: body["kb_scope"] = kb_scope
    t0 = time.time()
    r = requests.post(f"{API}/api/v1/chat/completions",
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                      json=body, timeout=timeout, stream=True)
    answer, citations, trace_meta = [], [], {}
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "): continue
        try: ev = json.loads(line[6:])
        except Exception: continue
        t = ev.get("type")
        if t == "delta": answer.append(ev.get("content", ev.get("delta", "")))
        elif t == "citation":
            c = ev.get("timeline_entry") or ev.get("citation")
            if c: citations.append(c)
        elif t == "trace": trace_meta = ev.get("trace") or trace_meta
        elif t == "error": answer.append(f"\n[STREAM-ERROR: {ev.get('message')}]")
    return {
        "answer": "".join(answer).strip(),
        "citations": [{"title": c.get("doc_title") or c.get("docTitle") or c.get("title") or c.get("documentTitle"), "kbName": c.get("kb_name") or c.get("kbName"),
                       "snippet": (c.get("snippet") or "")[:120]} for c in citations],
        "nCitations": len(citations),
        "latencySec": round(time.time() - t0, 1),
    }

# (用例ID, 问题, 必含关键词列表, 期望引用文档名含, 说明)
CASES = [
    ("RQ-01", "无人机条例中激光陀螺仪的标定周期是多少天？", ["45"], ["02b_legal_clean"], "中部锚点-条款文档"),
    ("RQ-02", "在禁飞区违规起降无人机会被罚款多少？", ["50万", "10万"], ["02b_legal_clean"], "尾部锚点-罚则"),
    ("RQ-03", "无人机条例的施行日期和废止情况？", ["2026", "2024"], ["02b_legal_clean"], "附则锚点-时效"),
    ("RQ-04", "运维考核总表里 EQ-0077 设备的巡检周期是多少天？", ["30"], ["04_big_table"], "表格行级检索"),
    ("RQ-05", "天穹-2026项目的总预算是多少？", ["3.75亿", "3.75"], ["06_ultra_long_25k"], "超长文档首部锚点"),
    ("RQ-06", "信息化纲要对子系统API平均响应时间的要求是多少？", ["800", "99.95"], ["06_ultra_long_25k"], "超长文档中部锚点"),
    ("RQ-07", "设备安全管理办法中特种设备的检验有效期是多久？", ["12"], ["20_regulation"], "DOCX中部锚点+表格"),
    ("RQ-08", "违反设备安全管理办法造成事故如何处理？", ["解除劳动合同", "通报批评"], ["20_regulation"], "DOCX尾部锚点"),
    ("RQ-09", "技术白皮书的版本号和密级是什么？", ["WP-2026-R9", "内部公开"], ["30_whitepaper"], "PDF首部锚点"),
    ("RQ-10", "运维手册规定核心交换机主备切换时间要求？", ["3秒"], ["31_longdoc"], "80页PDF中部锚点"),
    ("RQ-11", "培训课件的结业考核通过线是多少分？", ["85"], ["24_training"], "PPTX锚点"),
    ("RQ-12", "汇总表中记录的编号是什么？", ["SUM-2026-5566"], ["22_assessment"], "XLSX第二Sheet锚点"),
    ("RQ-13", "混排文档中的 ΨOmega-7 协议激活码是什么？", ["ΨOmega-7", "激活码"], ["05_mixed"], "特殊字符检索"),
    ("RQ-14", "HTML 产品介绍的 PRD 产品编号是多少？", ["PRD-2026-8899"], ["12_product_intro"], "HTML锚点"),
    ("RQ-15", "花名册里 EMP00077 的绩效评级是什么？", ["A"], ["11_roster"], "CSV行级检索"),
    ("RQ-16", "大数据量文档的验证码 BIGDOC-VERIFY 是多少？", ["7788"], ["21_large_3mb"], "3MB大DOCX尾部锚点"),
    ("RQ-17", "系统里有没有关于量子纠缠通信的技术方案？", [], [], "知识库外问题-应拒答"),
    ("RQ-18", "无人机条例一共有哪些章？请列出全部章名", ["总则", "飞行运行管理", "检测与维护", "罚则"], ["02b_legal_clean"], "全景列举-breadth"),
]

def main():
    token = login()
    r = requests.get(f"{API}/api/v1/kbs", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    kbs = r.json().get("items") or r.json().get("knowledgeBases") or r.json()
    kb = next((k for k in kbs if k["name"] == "系统测试-解析矩阵库"), None)
    scope = [kb["id"]] if kb else None
    print(f"[scope] {scope}")
    results = []
    for cid, q, keywords, docs, note in CASES:
        print(f"\n=== {cid}: {q} ({note}) ===", flush=True)
        try:
            res = chat(token, q, kb_scope=scope)
        except Exception as e:
            res = {"answer": f"EXC: {e}", "citations": [], "nCitations": 0, "latencySec": -1}
        cited_titles = " ".join((c.get("docTitle") or c.get("title") or "") for c in res["citations"])
        kw_hit = {k: (k in res["answer"]) for k in keywords}
        doc_hit = all(any(t in (c["title"] or "") for c in res["citations"]) for t in docs) if docs else True
        refuse = any(w in res["answer"] for w in ["没有", "未找到", "无法", "未包含", "不包含", "无相关", "未提及", "不在", "sorry", "Sorry"])
        if cid == "RQ-17":
            verdict = "PASS" if refuse else "FAIL(幻觉或未拒答)"
            res["_note"] = f"拒答检测={refuse}"
        else:
            all_kw = all(kw_hit.values()) if keywords else True
            any_kw = any(kw_hit.values()) if keywords else True
            if refuse and cid != "RQ-17":
                verdict = "FAIL(漏检-拒答但知识存在)"
            elif not any_kw:
                verdict = "FAIL(关键词未命中)"
            elif all_kw and doc_hit:
                verdict = "PASS"
            elif all_kw:
                verdict = "PASS(引用文档未匹配)" if doc_hit else "PASS-CD" if False else "PARTIAL(引用文档未匹配)"
            else:
                verdict = "PARTIAL(次要关键词缺失)"
        row = {"id": cid, "question": q, "note": note, **res,
               "keywordHits": kw_hit, "docHit": doc_hit, "verdict": verdict}
        results.append(row)
        print(f"  {verdict} | {res['latencySec']}s | kw={kw_hit} doc={doc_hit} cites={res['nCitations']}")
        print(f"  A: {res['answer'][:150]}")
        (RESULTS / "phase_b_results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    n_pass = sum(1 for r in results if r["verdict"] == "PASS")
    n_partial = sum(1 for r in results if r["verdict"] == "PARTIAL")
    print(f"\n===== Phase B: {n_pass} PASS / {n_partial} PARTIAL / {len(results)-n_pass-n_partial} FAIL =====")

if __name__ == "__main__":
    main()
