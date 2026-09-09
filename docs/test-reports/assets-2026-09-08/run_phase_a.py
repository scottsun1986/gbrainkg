#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLMWiki 阶段A测试执行器：知识库准备 + 多格式文档摄入矩阵测试"""
import json, os, sys, time
from pathlib import Path
import os
import requests

API = "http://127.0.0.1:3202"
ADMIN = {"username": os.environ.get("TEST_ADMIN_USER", "admin"),
         "password": os.environ.get("TEST_ADMIN_PASSWORD", "")}  # 凭据经环境变量注入,不入库
FILES = Path("/tmp/opencode/testdocs/files")
RESULTS = Path("/tmp/opencode/testdocs/results")
RESULTS.mkdir(parents=True, exist_ok=True)

def login(cred=ADMIN):
    r = requests.post(f"{API}/api/v1/auth/login", json=cred, timeout=15)
    r.raise_for_status()
    return r.json()["token"]

def ensure_kb(token, name):
    r = requests.get(f"{API}/api/v1/kbs", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    kbs = r.json().get("items") or r.json().get("knowledgeBases") or (r.json() if isinstance(r.json(), list) else [])
    for kb in kbs:
        if kb.get("name") == name:
            return kb["id"]
    r = requests.post(f"{API}/api/v1/admin/kbs", headers={"Authorization": f"Bearer {token}"},
                      json={"type": "personal", "name": name, "description": "自动化系统测试专用库(勿删)"}, timeout=15)
    r.raise_for_status()
    return r.json()["knowledgeBase"]["id"]

def upload(token, kb_id, path: Path, expect_reject=False):
    """上传单个文件, 返回 (doc_id 或 None, 响应信息)"""
    with open(path, "rb") as f:
        files = {"file": (path.name, f)}
        try:
            r = requests.post(f"{API}/api/v1/kbs/{kb_id}/documents",
                              headers={"Authorization": f"Bearer {token}"}, files=files, timeout=600)
        except requests.exceptions.ReadTimeout:
            return None, {"http": "timeout"}
    body = {}
    try: body = r.json()
    except Exception: body = {"raw": r.text[:300]}
    docs = body.get("documents") if isinstance(body.get("documents"), list) else []
    doc_id = (docs[0].get("id") if docs else None) or body.get("document", {}).get("id") or body.get("documentId")
    return doc_id, {"http": r.status_code, **({k: v for k, v in body.items() if k != 'document'} if isinstance(body, dict) else {})}

def doc_status(token, kb_id, doc_id):
    r = requests.get(f"{API}/api/v1/kbs/{kb_id}/documents/{doc_id}",
                     headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code != 200:
        return {"error": r.status_code}
    return r.json().get("document", r.json())

def wait_terminal(token, kb_id, doc_id, timeout=900, poll=5):
    """轮询直到终态 published/needs_review/failed, 返回 (终态, 详情, 耗时s)"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = doc_status(token, kb_id, doc_id)
        st = d.get("status")
        if st in ("published", "needs_review", "failed"):
            return st, d, round(time.time() - t0, 1)
        time.sleep(poll)
    return "timeout", {}, round(time.time() - t0, 1)

# 文件 → 预期映射: (文件名, 预期上传行为, 预期终态集, 超时)
MATRIX = [
    ("01_tiny_note.md",         "accept", {"published"}, 120),
    ("02_legal_clauses.md",     "accept", {"published"}, 300),
    ("03_deep_headings.md",     "accept", {"published"}, 300),
    ("04_big_table.md",         "accept", {"published"}, 300),
    ("05_mixed_charset.md",     "accept", {"published"}, 300),
    ("06_ultra_long_25k.md",    "accept", {"published"}, 600),
    ("07_malformed.md",         "accept", {"published", "needs_review"}, 300),
    ("10_plain_text.txt",       "accept", {"published"}, 300),
    ("11_roster.csv",           "accept", {"published"}, 300),
    ("12_product_intro.html",   "accept", {"published"}, 300),
    ("20_regulation.docx",      "accept", {"published"}, 600),
    ("21_large_3mb.docx",       "accept", {"published"}, 900),
    ("22_assessment_2krows.xlsx","accept", {"published"}, 600),
    ("23_large_100krows.xlsx",  "accept", {"published", "needs_review"}, 900),
    ("24_training_60slides.pptx","accept", {"published", "needs_review"}, 900),
    ("30_whitepaper_12p.pdf",   "accept", {"published"}, 600),
    ("31_longdoc_80p.pdf",      "accept", {"published"}, 900),
    ("40_fake_legacy.doc",      "accept", {"failed", "needs_review"}, 300),
    ("41_ocr_test.png",         "accept", {"needs_review", "failed", "published"}, 300),
    ("50_empty.txt",            "accept", {"failed", "needs_review"}, 120),
    ("51_whitespace.md",        "accept", {"failed", "needs_review"}, 120),
    ("52_corrupt.docx",         "accept", {"failed", "needs_review"}, 300),
    ("53_corrupt.pdf",          "accept", {"failed", "needs_review"}, 300),
    ("54_corrupt.xlsx",         "accept", {"failed", "needs_review"}, 300),
    ("55_wrong_ext.exe.exe",    "reject", None, 0),
    ("56_oversize_201mb.txt",   "reject", None, 0),
]

def main():
    token = login()
    kb_id = ensure_kb(token, "系统测试-解析矩阵库")
    print(f"[setup] test kb = {kb_id}")
    results = []
    for fname, expect, term, timeout in MATRIX:
        path = FILES / fname
        case = {"file": fname, "size_bytes": path.stat().st_size, "expect": expect}
        print(f"\n=== {fname} ({case['size_bytes']/1024:.1f} KB) expect={expect} ===", flush=True)
        doc_id, up = upload(token, kb_id, path)
        case["upload"] = up
        if expect == "reject":
            ok = up.get("http") in (400, 413) or "statusCode" in json.dumps(up)
            case["verdict"] = "PASS" if up.get("http", 200) >= 400 else "FAIL(expect reject)"
            print(f"  upload http={up.get('http')} → {case['verdict']}")
        elif doc_id:
            st, detail, dur = wait_terminal(token, kb_id, doc_id, timeout=timeout)
            case.update({
                "docId": doc_id, "finalStatus": st, "processSec": dur,
                "qualityStatus": detail.get("qualityStatus"),
                "qualityIssues": detail.get("qualityIssues"),
                "parserEngine": (detail.get("parserMeta") or {}).get("engine") or detail.get("parserEngine"),
                "chunkCount": detail.get("chunkCount") or (detail.get("chunks") and len(detail.get("chunks"))),
                "version": detail.get("version"),
            })
            if st == "timeout":
                case["verdict"] = "FAIL(timeout)"
            elif st in term:
                case["verdict"] = "PASS"
            else:
                case["verdict"] = f"UNEXPECTED({st})"
            print(f"  status={st} quality={case['qualityStatus']} engine={case['parserEngine']} chunks={case['chunkCount']} {dur}s → {case['verdict']}")
        else:
            case["verdict"] = f"FAIL(no docId: {json.dumps(up)[:150]})"
            print(f"  upload failed: {case['verdict']}")
        results.append(case)
        (RESULTS / "phase_a_results.json").write_text(json.dumps(
            {"kbId": kb_id, "results": results}, ensure_ascii=False, indent=2))
    n_pass = sum(1 for r in results if r["verdict"] == "PASS")
    print(f"\n===== Phase A done: {n_pass}/{len(results)} PASS =====")

if __name__ == "__main__":
    main()
