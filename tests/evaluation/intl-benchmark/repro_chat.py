#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Single-question chat reproduction with full SSE inspection.

The aggregate harnesses keep only `delta` text and citations, which is exactly
what you need to *score* a run and exactly what you need to throw away to
*debug* one. This tool keeps every event (including trace events) so an answer
that looks wrong can be traced back to the stage that produced it.

Usage:
    python3 repro_chat.py --kb <kb_id> --question "..."              # stream + summary
    python3 repro_chat.py --kb <kb_id> --question "..." --json-out /tmp/ev.json
"""

import argparse
import json
import os
import ssl
import time
import urllib.request

API = os.environ.get("API_BASE", "http://127.0.0.1:3202")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", required=True)
    parser.add_argument("--kb", action="append", default=[])
    parser.add_argument("--token", default=os.environ.get("LLMWIKI_TOKEN", ""))
    parser.add_argument("--json-out")
    parser.add_argument("--print-deltas", action="store_true")
    args = parser.parse_args()

    token = args.token
    if not token and os.path.exists("/tmp/llmwiki-eval-token"):
        token = open("/tmp/llmwiki-eval-token").read().strip()
    if not token:
        raise SystemExit("no token: pass --token or LLMWIKI_TOKEN")

    body = {"message": args.question}
    if args.kb:
        body["kb_scope"] = args.kb
    req = urllib.request.Request(f"{API}/api/v1/chat/completions",
                                 data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")

    events = []
    answer = []
    t0 = time.time()
    ttft = None
    with urllib.request.urlopen(req, timeout=600, context=CTX) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if payload == "[DONE]":
                break
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            events.append(event)
            kind = event.get("type")
            if kind == "delta":
                if ttft is None:
                    ttft = round(time.time() - t0, 2)
                answer.append(event.get("content") or "")
                if args.print_deltas:
                    print(f"[delta {time.time() - t0:6.1f}s] {event.get('content')!r}")
            elif kind == "trace":
                stage = event.get("stage") or event.get("id") or ""
                print(f"[trace {time.time() - t0:6.1f}s] {stage}: "
                      f"{event.get('title') or ''} {event.get('detail') or ''}".strip())
            else:
                print(f"[event {time.time() - t0:6.1f}s] type={kind}")

    text = "".join(answer)
    print("\n===== ANSWER =====")
    print(text)
    print("==================")
    print(f"ttft={ttft}s total={time.time() - t0:.2f}s deltas={len(answer)} "
          f"events={len(events)} answer_chars={len(text)}")
    if args.json_out:
        json.dump({"question": args.question, "kb": args.kb, "answer": text,
                   "events": events}, open(args.json_out, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"events written to {args.json_out}")


if __name__ == "__main__":
    main()
