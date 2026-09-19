export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface HistoryCompressOptions {
  /** Number of most-recent messages kept verbatim. */
  recentMessages?: number;
  /** Max characters for each older message's extractive digest. */
  olderSnippetChars?: number;
  /** Soft total character cap; oldest digests are dropped first. */
  maxTotalChars?: number;
}

/**
 * Deterministic, model-free compression of a long conversation. The previous
 * behaviour hard-truncated to the last 6 messages / 2,500 characters, so facts
 * and decisions from earlier turns vanished without trace. Here the most recent
 * turns stay verbatim (pronoun resolution depends on them) while older turns
 * are reduced to short extractive digests, keeping key entities and decisions
 * in the prompt at a bounded cost.
 */
export function compressConversationHistory(
  history: HistoryMessage[],
  options: HistoryCompressOptions = {},
): HistoryMessage[] {
  const recentMessages = Math.max(0, options.recentMessages ?? 6);
  const olderSnippetChars = Math.max(20, options.olderSnippetChars ?? 200);
  const maxTotalChars = Math.max(200, options.maxTotalChars ?? 3000);
  if (!history.length) return [];
  if (history.length <= recentMessages) {
    return history.map((message) => ({ ...message }));
  }

  const older = history.slice(0, history.length - recentMessages);
  const recent = history.slice(history.length - recentMessages).map((message) => ({ ...message }));
  const compressedOlder = older
    .map((message) => ({
      role: message.role,
      content: extractiveDigest(message.content, olderSnippetChars),
    }))
    .filter((message) => message.content.length > 0);

  let total =
    compressedOlder.reduce((sum, message) => sum + message.content.length, 0) +
    recent.reduce((sum, message) => sum + message.content.length, 0);
  while (compressedOlder.length > 0 && total > maxTotalChars) {
    total -= compressedOlder[0].content.length;
    compressedOlder.shift();
  }
  return [...compressedOlder, ...recent];
}

export function extractiveDigest(content: string, maxChars: number): string {
  const cleaned = String(content || "")
    .replace(/\[\d+\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[#>*`_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const boundaries = ["。", "！", "？", "；", ".", "!", "?"];
  let boundary = -1;
  for (const marker of boundaries) {
    boundary = Math.max(boundary, slice.lastIndexOf(marker));
  }
  const trimmed = boundary >= maxChars * 0.5 ? slice.slice(0, boundary + 1) : slice;
  return `${trimmed.trim()}…`;
}
