import { createHash } from "node:crypto";

/**
 * A GBrain Source represents a stable content repository. ACL changes must
 * never change this key: authorization is evaluated separately at read time.
 */
export function sourceKeyForKnowledgeBase(kbId: string): string {
  return `llmwiki-kb-${createHash("sha256")
    .update(kbId)
    .digest("hex")
    .slice(0, 16)}`;
}
