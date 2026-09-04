import { randomUUID } from "node:crypto";
import { MessageEvent } from "@nestjs/common";
import { Subscriber } from "rxjs";

export type ChatTraceStatus =
  | "running"
  | "success"
  | "warning"
  | "failed"
  | "skipped";

export interface ChatTraceNode {
  id: string;
  name: string;
  status: ChatTraceStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(api.?key|secret|password|authorization|access.?token|database.?url)/i;

function safeDetails(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const clean = (input: unknown, depth = 0): unknown => {
    if (depth > 4) return "[已省略]";
    if (Array.isArray(input)) return input.slice(0, 50).map((item) => clean(item, depth + 1));
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([key]) => !SENSITIVE_KEY.test(key))
          .slice(0, 50)
          .map(([key, item]) => [key, clean(item, depth + 1)]),
      );
    }
    if (typeof input === "string") return input.slice(0, 2_000);
    return input;
  };
  return clean(value) as Record<string, unknown>;
}

export class ChatTraceRecorder {
  readonly traceId = randomUUID();
  private readonly nodes = new Map<string, ChatTraceNode>();

  constructor(private readonly subscriber: Subscriber<MessageEvent>) {}

  start(
    id: string,
    name: string,
    summary?: string,
    details?: Record<string, unknown>,
  ): void {
    const node: ChatTraceNode = {
      id,
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(summary ? { summary } : {}),
      ...(safeDetails(details) ? { details: safeDetails(details) } : {}),
    };
    this.nodes.set(id, node);
    this.emit(node);
  }

  finish(
    id: string,
    status: Exclude<ChatTraceStatus, "running">,
    summary?: string,
    details?: Record<string, unknown>,
  ): void {
    const previous = this.nodes.get(id);
    const finishedAt = new Date();
    const startedAt = previous?.startedAt || finishedAt.toISOString();
    const node: ChatTraceNode = {
      id,
      name: previous?.name || id,
      status,
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - new Date(startedAt).getTime()),
      ...(summary || previous?.summary ? { summary: summary || previous?.summary } : {}),
      ...(safeDetails(details) || previous?.details
        ? { details: { ...(previous?.details || {}), ...(safeDetails(details) || {}) } }
        : {}),
    };
    this.nodes.set(id, node);
    this.emit(node);
  }

  skip(id: string, name: string, summary: string, details?: Record<string, unknown>): void {
    this.start(id, name);
    this.finish(id, "skipped", summary, details);
  }

  failRunning(error: unknown): void {
    const message = String((error as any)?.message || error || "未知错误").slice(0, 500);
    for (const node of this.nodes.values()) {
      if (node.status === "running") this.finish(node.id, "failed", message);
    }
  }

  snapshot(): ChatTraceNode[] {
    return [...this.nodes.values()];
  }

  private emit(node: ChatTraceNode): void {
    if (this.subscriber.closed) return;
    this.subscriber.next({
      data: {
        type: "trace",
        schema_version: 1,
        trace_id: this.traceId,
        node,
      },
    });
  }
}
