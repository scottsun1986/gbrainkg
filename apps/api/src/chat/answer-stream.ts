import { getChatTiming } from '../observability/chat-timing';
import type { Subscriber } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { metricsService } from '../observability/metrics.service';
import { isStructuralHeadingLine } from './ordered-answer';

/** Coarse pipeline stages surfaced to the client while the answer is building. */
export type ChatStage = 'retrieving' | 'reranking' | 'verifying' | 'generating';

export interface StageReporterDeps {
  subscriber: Subscriber<MessageEvent>;
  startedAt?: number;
  /** KNOWLEDGE_STRICT_OUTPUT=1 keeps the buffered one-shot contract. */
  strictOutput?: boolean;
  /**
   * Records the stage on the persisted chat run so a polling client can show
   * progress without an open stream. Optional: the SSE path has no run.
   */
  onStage?: (stage: ChatStage) => void;
}

/**
 * Stage progress + TTFT observability for the chat SSE stream.
 *
 * The client renders `type:'stage'` events as a live status line; unknown
 * event types are ignored by older clients, so emission is additive.
 */
export class StageReporter {
  private readonly subscriber: Subscriber<MessageEvent>;
  private readonly startedAt: number;
  private readonly strictOutput: boolean;
  private readonly onStage?: (stage: ChatStage) => void;
  private firstTextAt: number | null = null;
  /** Stages already timed, so a repeated transition (retry paths) counts once. */
  private readonly timedStages = new Set<ChatStage>();

  constructor(deps: StageReporterDeps) {
    this.subscriber = deps.subscriber;
    this.startedAt = deps.startedAt ?? Date.now();
    this.strictOutput = deps.strictOutput ?? false;
    this.onStage = deps.onStage;
  }

  emit(stage: ChatStage, detail?: string): void {
    const elapsed = Date.now() - this.startedAt;
    // Record the first time each phase is reached. The deltas between the
    // cumulative marks split time-to-first-token into retrieval, rerank,
    // generation and verification, which is the only way to tell a slow
    // retrieval pass apart from a slow model without guessing.
    if (!this.timedStages.has(stage)) {
      this.timedStages.add(stage);
      metricsService.observeChatStage(stage, elapsed);
    }
    // Report every transition, not just the first: a retry path can re-enter a
    // stage and the client should see it move backwards rather than stall.
    try { this.onStage?.(stage); } catch { /* progress is advisory */ }
    try {
      this.subscriber.next({
        data: { type: 'stage', stage, detail: detail ?? null, elapsed_ms: elapsed },
      });
    } catch {
      /* progress events must never break the answer stream */
    }
  }

  /** Prepared text may still be buffered by the authorization/transport layer. */
  markFirstText(): void {
    if (this.firstTextAt !== null) return;
    this.firstTextAt = Date.now();
    getChatTiming(this.startedAt).mark('answerPrepared');
  }

  markComplete(): void {
    metricsService.observeChatLatency('total', Date.now() - this.startedAt);
  }

  get isStrict(): boolean {
    return this.strictOutput;
  }
}

export function strictOutputEnabled(): boolean {
  return process.env.KNOWLEDGE_STRICT_OUTPUT === '1';
}

export function incrementalStreamingEnabled(): boolean {
  // Buffered by default. Incremental streaming pushes the verified prefix while
  // the model is still generating, but the grounding gate runs afterwards and
  // can drop or reinsert sentences, so the client rendered a prefix the final
  // answer no longer matched (sections out of order, a source header with
  // nothing under it). Final answer quality outranks first-token latency, so
  // streaming is opt-in via KNOWLEDGE_INCREMENTAL_STREAM=1. When it is on, the
  // caller emits an authoritative `replace` event if the post-gate text diverges
  // from what was streamed.
  // The strict contract (KNOWLEDGE_STRICT_OUTPUT=1) stays buffered either way.
  return !strictOutputEnabled() && process.env.KNOWLEDGE_INCREMENTAL_STREAM === '1';
}

/**
 * One rendered line of the ordered answer, classified against
 * tidyVerifiedAnswer so that any line we stream is guaranteed to survive
 * tidying byte-identically. Streaming a line tidy would drop or rewrite
 * would break the append-only client contract (the streamed prefix must be a
 * strict prefix of the final answer).
 */
interface RenderedLine {
  text: string;
  protectedByFence: boolean;
}

function scanLines(rendered: string): RenderedLine[] {
  let fence: { marker: string; length: number } | undefined;
  const out: RenderedLine[] = [];
  for (const line of rendered.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push({ text: line, protectedByFence: true });
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      continue;
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length };
      out.push({ text: line, protectedByFence: true });
      continue;
    }
    out.push({ text: line, protectedByFence: false });
  }
  return out;
}

type LineVerdict = { action: 'emit' | 'skip' | 'stop'; text: string };

/**
 * Mirrors tidyVerifiedAnswer's per-line survival and mutation rules:
 *  - emit: the line survives tidying byte-identically → safe to stream.
 *  - skip: tidy DROPS the line (marker-only, collapsed blank) → omit it and
 *    keep scanning, exactly like the final tidy output will.
 *  - stop: tidy may rewrite the line (odd bold), or its fate is still open
 *    (trailing heading, blank-as-tail) → hold it back for finishFinal().
 */
function tidyStableLine(
  lines: RenderedLine[],
  i: number,
  prevEmittedBlank: boolean,
): LineVerdict {
  const line = lines[i];
  if (line.protectedByFence) return { action: 'emit', text: line.text };
  const cleaned = line.text;
  if (!cleaned.trim()) {
    // Tidy keeps at most one blank between content lines: a blank whose
    // previously kept line was also blank is collapsed → skip.
    if (prevEmittedBlank) return { action: 'skip', text: '' };
    // First blank of a run: emit only if a later COMPLETE content line
    // exists — otherwise tidy pops it as a trailing blank and the pushed
    // prefix would diverge.
    for (let j = i + 1; j < lines.length - 1; j++) {
      if (!lines[j].text.trim()) continue;
      return { action: 'emit', text: '' };
    }
    return { action: 'stop', text: '' };
  }
  // Marker-only lines are dropped by tidy → skip (not a streaming blocker).
  const body = cleaned.replace(/\[\d+\]/g, '').replace(/[*_`#\s]/g, '');
  if (!body) return { action: 'skip', text: '' };
  // Odd bold count makes tidy strip ALL bold markers from the line — the
  // streamed bytes would diverge. Hold such lines back.
  const parts = cleaned.split(/(`+[^`]*`+)/g);
  const boldCount = parts.filter((_, i) => i % 2 === 0)
    .reduce((n, part) => n + (part.match(/(?<!\\)\*\*/g) || []).length, 0);
  if (boldCount % 2) return { action: 'stop', text: '' };
  // Headings: only emit one once a later complete line has been rendered under
  // it. tidy pops a trailing heading, and tidyVerifiedAnswer now also removes a
  // heading whose whole section is empty, so pushing one without content would
  // diverge from the final text.
  if (isStructuralHeadingLine(cleaned)) {
    for (let j = i + 1; j < lines.length - 1; j++) {
      if (!lines[j].text.trim()) continue;
      if (isStructuralHeadingLine(lines[j].text)) break;
      return { action: 'emit', text: cleaned };
    }
    return { action: 'stop', text: '' };
  }
  return { action: 'emit', text: cleaned };
}

/**
 * Incremental SSE answer streamer with an append-only client contract.
 *
 * The client accumulates `delta.content` chunks, so every pushed chunk must
 * extend the FINAL answer byte-identically. Chunks are cut only at tidy-stable
 * line boundaries (see tidyStableLine); anything tidy could drop or rewrite
 * stays pending and is resolved by finishFinal().
 */
export class IncrementalAnswerStreamer {
  private readonly subscriber: Subscriber<MessageEvent>;
  private readonly enabled: boolean;
  private readonly reporter: StageReporter | null;
  private pushed = '';
  private pushedLineCount = 0;

  constructor(deps: { subscriber: Subscriber<MessageEvent>; enabled: boolean; reporter?: StageReporter }) {
    this.subscriber = deps.subscriber;
    this.enabled = deps.enabled;
    this.reporter = deps.reporter ?? null;
  }

  get pushedLength(): number {
    return this.pushed.length;
  }

  /** Everything already pushed to the client, for prefix checks. */
  get streamedText(): string {
    return this.pushed;
  }

  /**
   * Offer the current ordered-answer render and stream its newly stable,
   * tidy-invariant prefix. `held` texts are sentences currently withheld by
   * the grounding gate: they (and everything after them) can still be
   * recovered or re-inserted, so streaming stops at the FIRST held sentence.
   * The verified prefix before it is final and streams immediately — this is
   * what keeps first-token latency low under strict grounding.
   */
  offerRender(rendered: string, held: string[]): void {
    if (!this.enabled) return;
    let stableRender = rendered;
    let boundary = rendered.length;
    for (const text of held) {
      const probe = String(text || '').trim();
      if (!probe) continue;
      const at = rendered.indexOf(probe);
      if (at >= 0 && at < boundary) boundary = at;
    }
    if (boundary < rendered.length) stableRender = rendered.slice(0, boundary);
    const { chunk, lineCount } = collectStablePrefix(stableRender, this.pushed, this.pushedLineCount);
    if (!chunk) return;
    this.pushedLineCount = lineCount;
    this.push(chunk);
  }

  /**
   * Resolve the stream against the final (tidied) answer. In incremental mode
   * pushes only the remainder; in strict mode pushes the whole answer once
   * (legacy buffered contract).
   */
  finishFinal(finalAnswer: string): void {
    if (!this.enabled) {
      this.push(finalAnswer);
      return;
    }
    if (!finalAnswer.startsWith(this.pushed)) {
      // Cannot happen by construction (only tidy-stable prefixes are pushed);
      // if it ever does, keep the user view consistent by appending the full
      // remainder after the longest common prefix and flag it loudly.
      const common = longestCommonPrefixLength(this.pushed, finalAnswer);
      this.push(finalAnswer.slice(common));
      metricsService.incStreamRepair();
    } else if (finalAnswer.length > this.pushed.length) {
      this.push(finalAnswer.slice(this.pushed.length));
    }
  }

  private push(chunk: string): void {
    if (!chunk) return;
    this.pushed += chunk;
    this.reporter?.markFirstText();
    this.subscriber.next({ data: { type: 'delta', content: chunk, delta: chunk } });
  }
}

function longestCommonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Pure helper: the tidy-invariant prefix of `rendered` that extends
 * `alreadyPushed` (which must equal pushedLines.join('\n')). Returns the new
 * chunk text and how many rendered lines it covers in total. Exported for
 * unit tests.
 *
 * Contract: `alreadyPushed + chunk` is always a byte-identical prefix of
 * tidyVerifiedAnswer(rendered-so-far)'s stable part — in particular the
 * pushed text NEVER ends with the trailing newline of its last line, because
 * tidyVerifiedAnswer joins lines without one and pops trailing blanks.
 */
export function collectStablePrefix(
  rendered: string,
  alreadyPushed: string,
  pushedLineCount = 0,
): { chunk: string; lineCount: number } {
  if (alreadyPushed.length > 0 && !rendered.startsWith(alreadyPushed)) {
    return { chunk: '', lineCount: pushedLineCount };
  }
  const lines = scanLines(rendered);
  let lineIndex = pushedLineCount;
  if (alreadyPushed.length > 0) {
    // Verify the pushed text still aligns with whole lines.
    let consumed = 0;
    for (let k = 0; k < pushedLineCount && k < lines.length; k++) consumed += lines[k].text.length + 1;
    if (consumed !== alreadyPushed.length + 1) {
      // Misaligned (pushed text ends mid-line): wait rather than risk divergence.
      return { chunk: '', lineCount: pushedLineCount };
    }
  }
  let prevEmittedBlank = lineIndex > 0 && !lines[lineIndex - 1].text.trim();
  const parts: string[] = [];
  for (let i = lineIndex; i < lines.length - 1; i++) {
    const verdict = tidyStableLine(lines, i, prevEmittedBlank);
    if (verdict.action === 'stop') break;
    if (verdict.action === 'skip') continue;
    parts.push(verdict.text);
    prevEmittedBlank = !verdict.text.trim();
  }
  if (!parts.length) return { chunk: '', lineCount: lineIndex };
  const chunk = (lineIndex > 0 ? '\n' : '') + parts.join('\n');
  return { chunk, lineCount: lineIndex + parts.length };
}
