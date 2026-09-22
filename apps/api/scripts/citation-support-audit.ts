#!/usr/bin/env node
/**
 * Citation-support audit over stored production answers (read-only).
 *
 * For every assistant message that carries citation markers, each marked
 * sentence is checked against the evidence it cites with the same deterministic
 * support test the answer pipeline uses. It reports:
 *
 *   markedSentences        sentences carrying [n]
 *   supported              supported by the evidence they cite
 *   misattributed          not supported by the cited evidence …
 *   repairable             … but supported by another citation of the same
 *                          answer (what the new re-binding step recovers)
 *   unsupported            supported by nothing in the answer's evidence
 *
 *   npx tsx scripts/citation-support-audit.ts --limit=200 [--since-days=7]
 *   npx tsx scripts/citation-support-audit.ts --since=2026-09-18T00:00:00Z
 */
import { PrismaClient } from '@prisma/client';
import { rebindCitationMarkers, statementSupportedBy } from '../src/chat/chat.service';

function argValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

interface CitationEntry {
  index?: number;
  snippet?: string;
  doc_title?: string;
  timeline_entry?: { snippet?: string; doc_title?: string };
}

function citationText(entry: CitationEntry): string {
  return String(entry?.timeline_entry?.snippet || entry?.snippet || '');
}

function citationTitle(entry: CitationEntry): string {
  return String(entry?.timeline_entry?.doc_title || entry?.doc_title || '');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    const limit = Number(argValue(argv, 'limit') || 200);
    const sinceDays = Number(argValue(argv, 'since-days') || 0);
    const sinceRaw = argValue(argv, 'since');
    const since = sinceRaw
      ? new Date(sinceRaw)
      : sinceDays > 0
        ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000)
        : null;

    const messages = await prisma.message.findMany({
      where: {
        role: 'assistant',
        citationsSummary: { not: null as any },
        content: { contains: '[' },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, content: true, citationsSummary: true, createdAt: true },
    });

    const totals = {
      messages: messages.length,
      messagesWithMarkers: 0,
      markedSentences: 0,
      supported: 0,
      misattributed: 0,
      repairable: 0,
      unsupported: 0,
      outOfRangeMarkers: 0,
      attributableElsewhere: 0,
    };
    const examples: any[] = [];

    for (const message of messages) {
      const citations = Array.isArray(message.citationsSummary)
        ? (message.citationsSummary as unknown as CitationEntry[])
        : [];
      if (!citations.length) continue;
      const sentences = String(message.content)
        .split(/(?:\n+|[。！？])/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 5 && /\[\d+\]/.test(s));
      if (!sentences.length) continue;
      totals.messagesWithMarkers += 1;

      for (const sentence of sentences) {
        const markers = Array.from(new Set(String(sentence).match(/\[(\d+)\]/g) || []))
          .map((m) => parseInt(m.replace(/\D/g, ''), 10));
        if (!markers.length) continue;
        totals.markedSentences += 1;

        const citedTexts = markers
          .filter((n) => n >= 1 && n <= citations.length)
          .map((n) => citationText(citations[n - 1]))
          .filter(Boolean);
        if (markers.some((n) => n < 1 || n > citations.length)) totals.outOfRangeMarkers += 1;
        if (!citedTexts.length) {
          totals.unsupported += 1;
          continue;
        }
        if (statementSupportedBy(sentence, citedTexts, true)) {
          totals.supported += 1;
          continue;
        }
        totals.misattributed += 1;
        // The stored citation array is compacted to the referenced entries, so
        // offline re-binding cannot recover the prompt numbering. What can be
        // measured is whether ANY citation of the same answer supports the
        // sentence: that is a lower bound on how many mis-attributions the
        // in-memory re-binding step can repair at answer time.
        const otherSupports = citations.some(
          (entry, index) =>
            !markers.includes(index + 1) &&
            statementSupportedBy(sentence, [citationText(entry)], true),
        );
        if (otherSupports) totals.attributableElsewhere += 1;
        const rebound = rebindCitationMarkers(sentence, citations);
        if (rebound) {
          totals.repairable += 1;
          if (examples.length < 6) {
            examples.push({
              messageId: message.id,
              createdAt: message.createdAt,
              sentence: sentence.slice(0, 120),
              citedAs: markers.join(','),
              shouldBe: rebound.index,
              citedTitle: citationTitle(citations[markers[0] - 1]).slice(0, 60),
              correctTitle: citationTitle(citations[rebound.index - 1]).slice(0, 60),
            });
          }
        } else {
          totals.unsupported += 1;
        }
      }
    }

    const rate = (n: number): number =>
      Number((n / Math.max(totals.markedSentences, 1)).toFixed(4));
    console.log(
      JSON.stringify(
        {
          window: since ? since.toISOString() : 'all-time',
          limit,
          ...totals,
          citationSupportRate: rate(totals.supported),
          misattributionRate: rate(totals.misattributed),
          repairableShareOfMisattributed: Number(
            (totals.repairable / Math.max(totals.misattributed, 1)).toFixed(4),
          ),
          attributableElsewhereShareOfMisattributed: Number(
            (totals.attributableElsewhere / Math.max(totals.misattributed, 1)).toFixed(4),
          ),
          examples,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
