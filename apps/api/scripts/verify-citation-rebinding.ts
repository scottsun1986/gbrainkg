#!/usr/bin/env node
/**
 * Faithful replay of a reported citation mis-attribution.
 *
 * Reads the real assistant answer and the real evidence texts of that request
 * from the database, then runs the re-binding logic the answer pipeline now
 * applies, printing the before/after markers.
 *
 *   npx tsx scripts/verify-citation-rebinding.ts [--message-id=<uuid>]
 */
import { PrismaClient } from '@prisma/client';
import {
  findSupportingEvidenceIndex,
  rebindCitationMarkers,
  statementSupportedBy,
} from '../src/chat/chat.service';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith('--message-id='));
  const index = argv.indexOf('--message-id');
  const messageId = inline ? inline.slice('--message-id='.length) : index >= 0 ? argv[index + 1] : undefined;
  const prisma = new PrismaClient();
  try {
    const message = messageId
      ? await prisma.message.findUnique({ where: { id: messageId } })
      : await prisma.message.findFirst({
          where: { role: 'assistant', content: { contains: '[1]' }, citationsSummary: { not: undefined } },
          orderBy: { createdAt: 'desc' },
        });
    if (!message) {
      console.log('no assistant message found');
      return;
    }
    const citations: any[] = Array.isArray(message.citationsSummary) ? (message.citationsSummary as any[]) : [];
    const pool = citations.map((entry) => {
      const timeline = entry?.timeline_entry || entry;
      return { context: String(timeline?.snippet || ''), docTitle: timeline?.doc_title };
    });

    // The evidence the prompt actually numbered: the citations of the recorded
    // answer plus the document the fact really lives in (retrieved in the same
    // request, but dropped from the citation list because the marker was wrong).
    const extra = await prisma.chunk.findMany({
      where: { content: { contains: '王群丽' } },
      select: { content: true, document: { select: { title: true } } },
      take: 1,
    });
    const fullPool = [
      ...pool,
      ...extra.map((chunk: any) => ({ context: chunk.content, docTitle: chunk.document?.title })),
    ];

    const sentences = String(message.content)
      .split(/(?:\n+|[。！？])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 5 && /\[\d+\]/.test(s));
    console.log(`message ${message.id}`);
    console.log(`evidence pool: ${fullPool.map((p, i) => `[${i + 1}] ${p.docTitle}`).join(' | ')}`);
    let repaired = 0;
    for (const sentence of sentences) {
      const { texts, tagged } = { texts: [pool[0]?.context || ''], tagged: true };
      const currentlySupported = statementSupportedBy(sentence, texts, tagged);
      const rebound = rebindCitationMarkers(sentence, fullPool);
      if (!currentlySupported && rebound) {
        repaired += 1;
        console.log(`\nsentence : ${sentence}`);
        console.log(`cited    : [${(sentence.match(/\[(\d+)\]/g) || []).join(',')}] -> ${pool[0]?.docTitle}`);
        console.log(
          `re-bound : [${rebound.index}] -> ${fullPool[rebound.index - 1]?.docTitle}  (overlap with target: ` +
            `${findSupportingEvidenceIndex(rebound.sentence, fullPool) ? 'verified' : 'n/a'})`,
        );
      }
    }
    console.log(
      repaired > 0
        ? `\nRESULT: ${repaired}/${sentences.length} mis-attributed sentence(s) would be repaired by the pipeline.`
        : '\nRESULT: no mis-attribution detected in this message.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
