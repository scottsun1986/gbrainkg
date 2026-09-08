#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阶段C：权限边界测试 —— 创建隔离测试用户/组织/三级库，验证可见性与越权"""
import json, random, string, time
from pathlib import Path
import os
import requests

API = "http://127.0.0.1:3202"
ADMIN = {"username": os.environ.get("TEST_ADMIN_USER", "admin"),
         "password": os.environ.get("TEST_ADMIN_PASSWORD", "")}  # 凭据经环境变量注入,不入库
RESULTS = Path("/tmp/opencode/testdocs/results")
TS = "09" + "".join(random.choices(string.digits, k=6))  # 用例时间戳

def login(cred):
    return requests.post(f"{API}/api/v1/auth/login", json=cred, timeout=15).json()["token"]

def main():
    admin_token = login(ADMIN)
    H = {"Authorization": f"Bearer {admin_token}"}
    results = []

    def record(cid, desc, expect, actual, verdict_extra=""):
        ok = verdict_extra or ("PASS" if expect == actual else f"FAIL(expect={expect})")
        results.append({"id": cid, "desc": desc, "expect": expect, "actual": actual, "verdict": ok})
        print(f"  [{ok}] {cid} {desc} → {actual}")

    # ===== 1. 建测试组织树: TX-根 > TX-子A; TX-根 > TX-子B =====
    def create_org(name, parent_id=None):
        r = requests.post(f"{API}/api/v1/admin/orgs", headers=H,
                          json={"name": name, **({"parentId": parent_id} if parent_id else {})}, timeout=15)
        return r.json().get("organization", r.json().get("org", r.json())).get("id")

    org_root = create_org(f"权限测试总部{TS}")
    org_a = create_org(f"权限测试A组{TS}", org_root)
    org_b = create_org(f"权限测试B组{TS}", org_root)
    assert org_root and org_a and org_b, "org creation failed"

    # ===== 2. 建测试用户 =====
    def create_user(username, display, org_id, password="Test@12345"):
        r = requests.post(f"{API}/api/v1/admin/users", headers=H,
                          json={"username": username, "displayName": display, "password": password,
                                "email": f"{username}@test.local", "orgIds": [org_id]}, timeout=15)
        return r.json().get("user", r.json())

    u_a = create_user(f"txa_{TS}", "A组读者", org_a)
    u_b = create_user(f"txb_{TS}", "B组读者", org_b)
    assert u_a and u_b, f"user creation failed: {u_a} {u_b}"

    # ===== 3. 建库: A组组织库 + 行业库(授权A组) + B组个人私有验证 =====
    r = requests.post(f"{API}/api/v1/admin/kbs", headers=H,
                      json={"type": "org", "name": f"权限测试A组知识库{TS}", "orgNodeId": org_a}, timeout=15)
    kb_a = r.json()["knowledgeBase"]["id"]
    r = requests.post(f"{API}/api/v1/admin/kbs", headers=H,
                      json={"type": "industry", "name": f"权限测试行业库{TS}"}, timeout=15)
    kb_ind = r.json()["knowledgeBase"]["id"]

    # 行业库授权给 A组读者（有效期）与 A组组织主体
    r = requests.post(f"{API}/api/v1/admin/grants", headers=H,
                      json={"kbId": kb_ind, "subjectType": "user", "subjectId": u_a["id"]}, timeout=15)
    if r.status_code >= 400: print("  grant user resp:", r.status_code, r.text[:120])

    # ===== 4. 向A组库与行业库注入机密知识 =====
    secret_a = f"机密A-{TS}: 北极星计划预算为9.87亿元"
    secret_ind = f"机密IND-{TS}: 行动代号朱雀，执行窗口11月"
    secret_doc_ids = []
    for kb_id, txt in [(kb_a, secret_a), (kb_ind, secret_ind)]:
        r = requests.post(f"{API}/api/v1/kbs/{kb_id}/documents/text", headers=H,
                          json={"title": f"机密指令{kb_id[:6]}.md", "content": f"# 机密文档\n\n{txt}。仅限授权人员知晓。"}, timeout=15)
        if r.status_code >= 400:
            print("  text upload:", r.status_code, r.text[:150])
        else:
            body = r.json()
            docs = body.get("documents") or body.get("document") or []
            did = (docs[0]["id"] if isinstance(docs, list) and docs else
                   (docs.get("id") if isinstance(docs, dict) else body.get("documentId")))
            if did: secret_doc_ids.append((kb_id, did))
    print(f"  等待知识编译(轮询至多25分钟)...", flush=True)
    t0 = time.time()
    while time.time() - t0 < 1500:
        states = []
        for kb_id, did in secret_doc_ids:
            rr = requests.get(f"{API}/api/v1/kbs/{kb_id}/documents/{did}", headers=H, timeout=15)
            states.append((rr.json().get("document") or {}).get("status"))
        print(f"    {int(time.time()-t0)}s states={states}", flush=True)
        if all(s == "published" for s in states) or any(s in ("failed", "needs_review") for s in states):
            break
        time.sleep(30)
    time.sleep(20)

    # ===== 5. 可见性矩阵验证 =====
    def visible_kbs(username, password="Test@12345"):
        tok = login({"username": username, "password": password})
        r = requests.get(f"{API}/api/v1/session/bootstrap", headers={"Authorization": f"Bearer {tok}"}, timeout=15)
        return tok, r.json()

    tok_a, boot_a = visible_kbs(f"txa_{TS}")
    a_kb_ids = [k["id"] for k in (boot_a.get("knowledgeBases") or [])]
    tok_b, boot_b = visible_kbs(f"txb_{TS}")
    b_kb_ids = [k["id"] for k in (boot_b.get("knowledgeBases") or [])]

    record("PM-01", "A组读者可见A组组织库", True, kb_a in a_kb_ids)
    record("PM-02", "A组读者可见被授权行业库", True, kb_ind in a_kb_ids)
    record("PM-03", "B组读者不可见A组组织库(同父不同子)", False, kb_a in b_kb_ids)
    record("PM-04", "B组读者不可见行业库(未授权)", False, kb_ind in b_kb_ids)

    # ===== 6. 检索越权验证 =====
    def ask(tok, q, scope=None):
        body = {"message": q}
        if scope: body["kb_scope"] = scope
        r = requests.post(f"{API}/api/v1/chat/completions",
                          headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                          json=body, timeout=90, stream=True)
        ans, cites = [], []
        for line in r.iter_lines(decode_unicode=True):
            if line and line.startswith("data: "):
                try: ev = json.loads(line[6:])
                except Exception: continue
                if ev.get("type") == "delta": ans.append(ev.get("delta", ""))
                if ev.get("type") == "citation" and ev.get("citation"): cites.append(ev["citation"])
        return "".join(ans), cites

    ans_a, cites_a = ask(tok_a, "北极星计划预算是多少？")
    record("PM-05", "A组读者可查到机密A", True, "9.87亿" in ans_a)
    ans_b, cites_b = ask(tok_b, "北极星计划预算是多少？")
    record("PM-06", "B组读者查不到机密A(内容不泄露)", True, "9.87亿" not in ans_b)
    ans_b2, _ = ask(tok_b, "行动代号朱雀的执行窗口？")
    record("PM-07", "B组读者查不到行业库机密", True, "11月" not in ans_b2 or "朱雀" not in ans_b2)

    # ===== 7. 指定越权 scope 检索 → 403/过滤 =====
    r = requests.post(f"{API}/api/v1/chat/completions",
                      headers={"Authorization": f"Bearer {tok_b}", "Content-Type": "application/json"},
                      json={"message": "北极星计划预算", "kb_scope": [kb_a]}, timeout=60)
    record("PM-08", "B组读者强制指定A组库scope被拒(403/404)", True, r.status_code in (403, 404))

    # ===== 8. 上传越权: B组读者向A组库上传 → 403 =====
    r = requests.post(f"{API}/api/v1/kbs/{kb_a}/documents", headers={"Authorization": f"Bearer {tok_b}"},
                      files={"file": ("hack.md", b"# hack\nattack")}, timeout=15)
    record("PM-09", "B组读者向A组库上传被拒", True, r.status_code == 403)

    # ===== 9. B组读者建自己的个人库+上传（应成功且A不可见）=====
    r = requests.post(f"{API}/api/v1/admin/kbs", headers={"Authorization": f"Bearer {tok_b}"},
                      json={"type": "personal", "name": f"B组私人库{TS}"}, timeout=15)
    if r.status_code < 400:
        kb_b_personal = r.json()["knowledgeBase"]["id"]
        r = requests.post(f"{API}/api/v1/kbs/{kb_b_personal}/documents/text",
                          headers={"Authorization": f"Bearer {tok_b}"},
                          json={"title": "私人笔记.md", "content": "# 私人\nB组私人机密代号BLUE-991。"}, timeout=15)
        record("PM-10", "B组读者个人库自助创建并写入", 201, r.status_code)
        # 轮询个人库文档发布
        body = r.json()
        docs = body.get("documents") or body.get("document") or []
        pdid = (docs[0]["id"] if isinstance(docs, list) and docs else
                (docs.get("id") if isinstance(docs, dict) else None))
        if pdid:
            t0 = time.time()
            while time.time() - t0 < 900:
                rr = requests.get(f"{API}/api/v1/kbs/{kb_b_personal}/documents/{pdid}",
                                  headers={"Authorization": f"Bearer {tok_b}"}, timeout=15)
                if (rr.json().get("document") or {}).get("status") in ("published", "failed", "needs_review"):
                    print(f"    personal doc state={(rr.json().get('document') or {}).get('status')} @{int(time.time()-t0)}s")
                    break
                time.sleep(20)
        _, boot_a2 = visible_kbs(f"txa_{TS}")
        a2_ids = [k["id"] for k in (boot_a2.get("knowledgeBases") or [])]
        record("PM-11", "A组读者不可见B组个人库", False, kb_b_personal in a2_ids)
        ans_a3, _ = ask(tok_a, "BLUE-991是什么？")
        record("PM-12", "A组读者检索不到B组私人机密", True, "BLUE-991" not in ans_a3)
    else:
        record("PM-10", "B组读者个人库自助创建并写入", "201", f"{r.status_code}: {r.text[:80]}")

    # ===== 10. 撤销授权即时生效 =====
    r = requests.get(f"{API}/api/v1/admin/data", headers=H, timeout=15)
    grants = [g for g in r.json().get("grants", []) if g.get("kbId") == kb_ind]
    if grants:
        gid = grants[0]["id"]
        requests.delete(f"{API}/api/v1/admin/grants", headers=H, json={"id": gid}, timeout=15)
        time.sleep(8)
        _, boot_a3 = visible_kbs(f"txa_{TS}")
        a3_ids = [k["id"] for k in (boot_a3.get("knowledgeBases") or [])]
        record("PM-13", "撤销行业库授权后A组读者立即不可见", False, kb_ind in a3_ids)
        ans_a4, _ = ask(tok_a, "行动代号朱雀的执行窗口？")
        record("PM-14", "撤销后A组读者检索不到行业库机密", True, "11月" not in ans_a4 or "朱雀" not in ans_a4)

    (RESULTS / f"phase_c_results.json").write_text(
        json.dumps({"ts": TS, "orgs": {"root": org_root, "a": org_a, "b": org_b},
                    "users": {"a": u_a["id"], "b": u_b["id"]},
                    "kbs": {"orgA": kb_a, "industry": kb_ind},
                    "results": results}, ensure_ascii=False, indent=2))
    n = sum(1 for r in results if r["verdict"] == "PASS")
    print(f"\n===== Phase C: {n}/{len(results)} PASS =====")

if __name__ == "__main__":
    main()
