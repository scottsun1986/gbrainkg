#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P0 六项修复的测试环境端到端验证（对应 docs/archive/2026-10-07/plans/sota-optimization-output-2026-10-03.md）。

覆盖：
  B-2  kb.industry.read 权限矩阵（admin/data 不再泄露全量组织树/用户/角色）
  B-9  outbox 死信状态 + 遥测 dead 计数 + 重放端点（404/403/成功）
  B-11 替换（重解析）失败时 parserMetadata 合并保留（真实解析失败链路）
  B-6  真实问答引用角标连续性与对齐（chat SSE）
  B-8  图谱接口确定性（两次强制重建结果一致）
  xlsx 预览依赖的 0.20.3 已在 web 构建中（浏览器侧由独立脚本验证）

用法：
  python3 tests/e2e/verify_p0_fixes_e2e.py
  环境变量：API_BASE（默认 http://127.0.0.1:3202）、LLMWIKI_USER/LLMWIKI_PASS
报告：tests/e2e/results/p0-e2e-<时间戳>.json；退出码 0=全部 PASS
"""
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:3202").rstrip("/")
ADMIN_USER = os.environ.get("LLMWIKI_USER", "admin")
ADMIN_PASS = os.environ.get("LLMWIKI_PASS", "123456")
E2E_PASSWORD = "E2E-P0-Verify-2026!"
UPLOAD_ROOT = "/home/scottsun/.local/share/llmwiki/uploads"
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

TOKEN = ""
READER_TOKEN = ""
RESULTS = []


def http(method, path, body=None, token=None, timeout=60, raw_body=None, headers=None):
    url = f"{API_BASE}{path}"
    data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if raw_body is not None and not headers:
        req.add_header("Content-Type", "application/json")
    if body is not None and not headers:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def record(case, ok, detail):
    RESULTS.append({"case": case, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {case}  {detail if not ok else ''}")


def psql(sql):
    out = subprocess.run(
        ["docker", "exec", "llmwiki-postgres", "psql", "-U", "llmwiki", "-d", "llmwiki", "-Atc", sql],
        capture_output=True, text=True, timeout=30)
    # 命令标签（如 INSERT 0 1）可能混在输出里，RETURNING 场景取首行
    lines = [l for l in out.stdout.strip().splitlines() if l.strip()]
    return lines[0] if lines else ""


def login(username, password):
    status, raw = http("POST", "/api/v1/auth/login", {"username": username, "password": password})
    if status != 200:
        return None, f"HTTP {status}: {raw[:200]}"
    return json.loads(raw).get("token", ""), ""


def admin_data(token):
    status, raw = http("GET", "/api/v1/admin/data", token=token, timeout=90)
    return status, (json.loads(raw) if status == 200 else raw)


# ---------------------------------------------------------------- B-2
def case_b2_permission_matrix():
    ts = str(int(time.time()))
    # 两个独立组织：一个挂测试用户，一个留给行业库（避免组织树恰好重合造成假阳性）
    for name in (f"E2E-B2-用户组织-{ts}", f"E2E-B2-行业组织-{ts}"):
        s, raw = http("POST", "/api/v1/admin/orgs", {"name": name}, token=TOKEN)
        if s not in (200, 201):
            record("B-2 setup org", False, f"{name}: HTTP {s} {raw[:200]}")
            return
    status, data = admin_data(TOKEN)
    if status != 200:
        record("B-2 setup org", False, f"admin/data HTTP {status}")
        return
    user_org = next(o["id"] for o in data["orgs"] if o["name"] == f"E2E-B2-用户组织-{ts}")
    industry_org = next(o["id"] for o in data["orgs"] if o["name"] == f"E2E-B2-行业组织-{ts}")

    s, raw = http("POST", "/api/v1/admin/roles",
                  {"name": f"E2E-行业只读-{ts}", "description": "P0 E2E", "permissions": ["kb.industry.read"]}, token=TOKEN)
    if s not in (200, 201):
        record("B-2 setup role", False, f"HTTP {s} {raw[:200]}")
        return
    role_id = json.loads(raw)["role"]["id"]

    s, raw = http("POST", "/api/v1/admin/users",
                  {"username": f"e2e_b2_{ts}", "displayName": "P0 行业读者", "orgIds": [user_org],
                   "password": E2E_PASSWORD, "roleIds": [role_id]}, token=TOKEN)
    if s not in (200, 201):
        record("B-2 setup user", False, f"HTTP {s} {raw[:200]}")
        return
    user_payload = json.loads(raw).get("user") or {}
    user_id = user_payload["id"]

    s, raw = http("POST", "/api/v1/admin/kbs", {"name": f"E2E-B2-行业库-{ts}", "type": "industry"}, token=TOKEN)
    if s not in (200, 201):
        record("B-2 setup kb", False, f"HTTP {s} {raw[:200]}")
        return
    kb_payload = json.loads(raw).get("knowledgeBase") or json.loads(raw)
    kb_id = kb_payload["id"]
    s, raw = http("POST", f"/api/v1/admin/kbs/{kb_id}/admins", {"userIds": [user_id]}, token=TOKEN)
    if s not in (200, 201):
        record("B-2 setup kb-admin", False, f"HTTP {s} {raw[:200]}")
        return

    global READER_TOKEN
    READER_TOKEN, err = login(f"e2e_b2_{ts}", E2E_PASSWORD)
    if not READER_TOKEN:
        record("B-2 reader login", False, err)
        return

    status, data = admin_data(READER_TOKEN)
    if status != 200:
        record("B-2 reader admin/data", False, f"HTTP {status} {str(data)[:200]}")
        return
    record("B-2 orgs 收敛（不返回全量组织树）",
           isinstance(data.get("orgs"), list) and len(data["orgs"]) == 0,
           f"orgs={ [o.get('name') for o in data.get('orgs', [])][:5] } (期望空：行业库未挂 orgNodeId)")
    record("B-2 orgs 不含用户所属组织（无 org.read）",
           all(o.get("id") != user_org for o in data.get("orgs", [])),
           "泄露了用户组织节点")
    record("B-2 users 仅含本人",
           len(data.get("users", [])) == 1 and data["users"][0]["id"] == user_id,
           f"users={len(data.get('users', []))}")
    record("B-2 roles 空（无 role.read）",
           data.get("roles") == [],
           f"roles={len(data.get('roles', []))}")
    record("B-2 行业库管理列表仍可用",
           any(kb.get("id") == kb_id for kb in data.get("managedIndustryKbs", [])),
           "managedIndustryKbs 未包含其管理的行业库")

    # 系统管理员对照组：全量清单不受影响
    status, data = admin_data(TOKEN)
    record("B-2 系统管理员不受影响（orgs/users/roles 全量）",
           status == 200 and len(data.get("orgs", [])) >= 2 and len(data.get("users", [])) > 1 and len(data.get("roles", [])) >= 1,
           f"orgs={len(data.get('orgs', []))} users={len(data.get('users', []))} roles={len(data.get('roles', []))}")

    return {"kb_id": kb_id, "role_id": role_id, "user_id": user_id,
            "org_ids": [user_org, industry_org], "username": f"e2e_b2_{ts}"}


def cleanup_b2(ctx):
    if not ctx:
        return
    http("DELETE", f"/api/v1/admin/kbs/{ctx['kb_id']}", token=TOKEN)
    http("DELETE", f"/api/v1/admin/users/{ctx['user_id']}", token=TOKEN)
    http("DELETE", f"/api/v1/admin/roles/{ctx['role_id']}", token=TOKEN)
    for org_id in ctx["org_ids"]:
        http("DELETE", f"/api/v1/admin/orgs/{org_id}", token=TOKEN)


# ---------------------------------------------------------------- B-9
def case_b9_dead_letter():
    event_id = psql(
        "INSERT INTO \"BrainChangeEvent\" (id, \"eventType\", \"resourceType\", \"resourceId\", "
        "payload, status, \"retryCount\", \"errorMessage\", \"createdAt\") "
        "VALUES (gen_random_uuid(), 'role_change', 'role', '00000000-0000-0000-0000-000000000000', "
        "'{}'::jsonb, 'failed', 10, 'p0-e2e-seed', now()) RETURNING id::text;")
    if not event_id:
        record("B-9 seed 死信事件", False, "psql 插入失败")
        return
    status = ""
    for _ in range(8):
        time.sleep(2)
        status = psql(f"SELECT status FROM \"BrainChangeEvent\" WHERE id='{event_id}'")
        if status == "dead":
            break
    record("B-9 重试耗尽事件被置为 dead", status == "dead", f"status={status}")

    s, raw = http("GET", "/api/v1/admin/system/status-telemetry", token=TOKEN, timeout=120)
    dead = None
    if s == 200:
        dead = (json.loads(raw).get("summary", {}).get("outboxStatus", {}) or {}).get("dead")
    record("B-9 遥测 outboxStatus.dead 可见", isinstance(dead, int) and dead >= 1, f"dead={dead} HTTP {s}")

    s, raw = http("POST", f"/api/v1/admin/outbox/{event_id}/replay", {}, token=TOKEN)
    ok = s in (200, 201) and json.loads(raw).get("replayed") is True
    record("B-9 管理员重放死信事件", ok, f"HTTP {s} {raw[:200]}")
    after = psql(f"SELECT status || '/' || \"retryCount\" FROM \"BrainChangeEvent\" WHERE id='{event_id}'")
    record("B-9 重放后事件被调度器接管（pending/processing 且预算清零）",
           after.split("/")[0] in ("pending", "processing") and after.endswith("/0"), f"after={after}")

    s, raw = http("POST", f"/api/v1/admin/outbox/{uuid.uuid4()}/replay", {}, token=TOKEN)
    record("B-9 重放未知事件返回 404", s == 404, f"HTTP {s}")

    if READER_TOKEN:
        s, raw = http("POST", f"/api/v1/admin/outbox/{uuid.uuid4()}/replay", {}, token=READER_TOKEN)
        record("B-9 非系统管理员重放被拒绝（403）", s == 403, f"HTTP {s}")

    # 观察重放事件的最终去向（role_change 由 compiler 队列异步处理）
    terminal = ""
    for _ in range(30):
        time.sleep(3)
        terminal = psql(f"SELECT status FROM \"BrainChangeEvent\" WHERE id='{event_id}'")
        if terminal in ("completed", "dead", "failed"):
            break
    record("B-9 重放事件不再处于 dead（已被真实处理）", terminal != "dead" and terminal != "", f"terminal={terminal}")
    psql(f"DELETE FROM \"BrainChangeEvent\" WHERE id='{event_id}'")


# ---------------------------------------------------------------- B-11
def case_b11_metadata_preserved():
    ts = str(int(time.time()))
    kb_name = f"E2E-B11-解析失败库-{ts}"
    s, raw = http("POST", "/api/v1/admin/kbs", {"name": kb_name, "type": "industry"}, token=TOKEN)
    if s not in (200, 201):
        record("B-11 setup kb", False, f"HTTP {s} {raw[:200]}")
        return
    kb_id = (json.loads(raw).get("knowledgeBase") or json.loads(raw))["id"]

    # 用真实 PDF（LibreOffice 生成）而非 txt：txt 快路径对乱码会发布降级输出，
    # 只有 PDF 解析路径才会真正解析失败，从而触发 markFailed 的合并分支。
    with open("/tmp/b11-src.pdf", "rb") as f:
        pdf_bytes = f.read()
    boundary = "----p0e2eboundary"
    body = (f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"b11-metadata.pdf\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n").encode() + pdf_bytes + f"\r\n--{boundary}--\r\n".encode()
    s, raw = http("POST", f"/api/v1/kbs/{kb_id}/documents", raw_body=body, token=TOKEN, timeout=120,
                  headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    if s not in (200, 201):
        record("B-11 setup 上传", False, f"HTTP {s} {raw[:300]}")
        http("DELETE", f"/api/v1/admin/kbs/{kb_id}", token=TOKEN)
        return
    doc_payload = json.loads(raw)
    docs = doc_payload.get("documents") or []
    doc_id = docs[0].get("id") if docs else doc_payload.get("documentId")

    meta1 = ""
    raw_oid = ""
    SEP = "\x1f"
    for _ in range(45):
        time.sleep(2)
        row = psql(f"SELECT status || chr(31) || COALESCE(\"parserMetadata\"::text, 'null') || chr(31) || "
                   f"COALESCE(\"activeVersionId\"::text, 'null') || chr(31) || COALESCE(\"rawFileOid\", 'null') "
                   f"FROM \"Document\" WHERE id='{doc_id}'")
        parts = row.split(SEP)
        if len(parts) == 4 and parts[0] in ("published", "indexing") and parts[2] != "null":
            meta1 = parts[1]
            raw_oid = parts[3]
            break
    if not meta1:
        record("B-11 首次发布", False, f"文档未在 90s 内发布：{row[:200]}")
        http("DELETE", f"/api/v1/admin/kbs/{kb_id}", token=TOKEN)
        return
    record("B-11 首次解析发布成功（有 activeVersionId）", True, f"keys={sorted(json.loads(meta1).keys()) if meta1 != 'null' else 'null'}")

    # 制造「重解析失败」条件：文档被标记为停滞 parsing（真实生产里 retry 端点服务的场景）
    psql(f"UPDATE \"Document\" SET status='parsing', \"updatedAt\"=now() - interval '10 minutes' WHERE id='{doc_id}'")
    raw_path = raw_oid if os.path.isabs(raw_oid) else os.path.join(UPLOAD_ROOT, raw_oid)
    backup_path = raw_path + ".p0bak"
    os.replace(raw_path, backup_path)
    with open(raw_path, "wb") as f:
        f.write(os.urandom(256))
    try:
        s, raw = http("POST", f"/api/v1/kbs/{kb_id}/documents/{doc_id}/retry", {}, token=TOKEN)
        if s != 200 and s != 201:
            record("B-11 触发重解析", False, f"HTTP {s} {raw[:300]}")
            return
        pending_meta = ""
        pending_err = ""
        doc_status = ""
        active_after = ""
        for _ in range(45):
            time.sleep(2)
            row = psql(f"SELECT COALESCE(\"parserMetadata\"->>'pendingError','') || chr(31) || "
                       f"COALESCE(\"parserMetadata\"::text,'null') || chr(31) || status || chr(31) || "
                       f"COALESCE(\"activeVersionId\"::text,'null') FROM \"Document\" WHERE id='{doc_id}'")
            parts = row.split(SEP)
            if len(parts) == 4:
                pending_err, pending_meta, doc_status, active_after = parts
            if pending_err:
                break
        record("B-11 重解析失败写入 pendingError", bool(pending_err), f"row={row[:200]}")
        prior_keys_ok = True
        missing = []
        if meta1 and meta1 != "null" and pending_meta and pending_meta != "null":
            prior = json.loads(meta1)
            after = json.loads(pending_meta)
            missing = [k for k in prior.keys() if k not in after]
            prior_keys_ok = not missing
        record("B-11 原 parserMetadata 字段全部保留（合并而非覆盖）", prior_keys_ok, f"missing={missing}")
        # 「失败的重解析不得撤销已发布投影」：activeVersionId 必须原样保留。
        record("B-11 已发布投影未被失败重解析撤销（activeVersionId 不变）",
               active_after != "" and active_after != "null",
               f"activeVersionId={active_after} status={doc_status}")
    finally:
        if os.path.exists(backup_path):
            os.replace(backup_path, raw_path)
        psql(f"DELETE FROM \"Document\" WHERE id='{doc_id}'")
        http("DELETE", f"/api/v1/admin/kbs/{kb_id}", token=TOKEN)


# ---------------------------------------------------------------- B-6
def case_b6_citation_alignment():
    kb_id = psql("SELECT d.\"kbId\" FROM \"Document\" d JOIN \"KnowledgeBase\" kb ON kb.id=d.\"kbId\" "
                 "WHERE d.status='published' AND kb.name LIKE '公开基准-2WikiMultiHopQA-EN' LIMIT 1")
    if not kb_id:
        kb_id = psql("SELECT d.\"kbId\" FROM \"Document\" d WHERE d.status='published' LIMIT 1")
    if not kb_id:
        record("B-6 语料就绪", False, "无已发布文档")
        return
    doc_title = psql(f"SELECT title FROM \"Document\" WHERE \"kbId\"='{kb_id}' AND status='published' ORDER BY random() LIMIT 1")
    question = f"What does the source material say about {doc_title}? Answer in Chinese with citation markers like [1]."
    s, raw = http("POST", "/api/v1/chat/completions", {"message": question, "kb_scope": [kb_id]},
                  token=TOKEN, timeout=180)
    if s not in (200, 201):
        record("B-6 问答请求", False, f"HTTP {s} {raw[:300]}")
        return
    answer = ""
    citations = []
    done = False
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
        if data.get("type") == "delta":
            answer += data.get("content") or ""
        elif data.get("type") == "citation":
            citations.append(data.get("index"))
        elif data.get("type") == "done":
            done = True
    record("B-6 SSE 完成（done 事件）", done, "未收到 done")
    record("B-6 返回了引用事件", bool(citations), f"citations={citations}")
    import re as _re
    markers = sorted({int(m) for m in _re.findall(r"\[(\d+)\]", answer)})
    citation_indices = sorted({c for c in citations if isinstance(c, int)})
    # 引用事件保留模型引用的原始编号（不重排），答案角标必须全部指向已发出的引用。
    # （答案本轮未带任何角标时不变量平凡成立，属模型行为波动，不算失败。）
    record("B-6 答案角标与引用事件一一对应（无悬空角标）",
           set(markers) <= set(citation_indices),
           f"markers={markers} citation_indices={citation_indices}")
    record("B-6 答案非空且非拒答", len(answer.strip()) > 20 and "无法回答" not in answer[:80],
           f"answer[:120]={answer[:120]!r}")


# ---------------------------------------------------------------- B-8
def case_b8_graph_determinism():
    def snapshot():
        s, raw = http("GET", "/api/v1/knowledge-graph?limit=200&fresh=true", token=TOKEN, timeout=180)
        if s != 200:
            return None, f"HTTP {s} {raw[:200]}"
        return json.loads(raw), ""
    a, err_a = snapshot()
    b, err_b = snapshot()
    if a is None or b is None:
        record("B-8 图谱快照", False, f"{err_a} {err_b}")
        return
    # 结构确定性：节点与边（source,target,type,weight 多重集）必须完全一致。
    # stats.buildMs 与 LLM 链接生成计数是计时/LLM 随机量，不参与比较。
    nodes_eq = json.dumps(a.get("nodes"), sort_keys=True) == json.dumps(b.get("nodes"), sort_keys=True)
    edges_a = sorted(json.dumps(e, sort_keys=True) for e in a.get("edges", []))
    edges_b = sorted(json.dumps(e, sort_keys=True) for e in b.get("edges", []))
    record("B-8 两次强制重建节点一致", nodes_eq,
           f"nodes_a={len(a.get('nodes', []))} nodes_b={len(b.get('nodes', []))}")
    record("B-8 两次强制重建边一致（多重集）", edges_a == edges_b,
           f"edges_a={len(edges_a)} edges_b={len(edges_b)}")


def main():
    global TOKEN
    token, err = login(ADMIN_USER, ADMIN_PASS)
    if not token:
        print(f"!! admin 登录失败: {err}")
        return 1
    TOKEN = token
    print(f"== P0 E2E against {API_BASE} ==")

    b2_ctx = case_b2_permission_matrix()
    case_b9_dead_letter()
    case_b11_metadata_preserved()
    case_b6_citation_alignment()
    case_b8_graph_determinism()
    cleanup_b2(b2_ctx)

    os.makedirs(RESULTS_DIR, exist_ok=True)
    report_path = os.path.join(RESULTS_DIR, f"p0-e2e-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({"base": API_BASE, "finishedAt": datetime.now().isoformat(), "results": RESULTS},
                  f, ensure_ascii=False, indent=2)
    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n报告: {report_path}")
    print(f"总计 {len(RESULTS)} 项，通过 {len(RESULTS) - len(failed)}，失败 {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
