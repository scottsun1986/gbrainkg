/**
 * Bad-case ingestion flywheel.
 *
 * Converts a user-flagged inaccurate answer into a permanent golden-dataset
 * regression case so the quality gate catches the same failure on every
 * future release.
 *
 * Usage:
 *   npx tsx tests/evaluation/ingest-bad-case.ts \
 *     --question "雨雪天偏航扣多少分？" \
 *     --keywords "偏航,扣分,雨雪" \
 *     --doc "02_legal_clauses.md" \
 *     --category factual_precision \
 *     [--scope kb-xxx] \
 *     [--no-answer] \
 *     [--answer "错误回答原文"] \
 *     [--trace /tmp/trace.json]
 */
import fs from 'fs';
import path from 'path';

interface GoldenCase {
  id: string;
  category: string;
  question: string;
  expected_kb_scope: string[];
  expected_document_titles: string[];
  expected_keywords: string[];
  expected_no_answer: boolean;
  requires_auth_user: string | null;
  unauthorized_users: string[];
  notes: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main() {
  const question = arg('question');
  if (!question?.trim()) {
    console.error('Missing required --question');
    process.exit(1);
  }

  const datasetPath = path.join(__dirname, 'golden-dataset.json');
  const dataset: GoldenCase[] = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));

  const normalized = question.trim().toLowerCase();
  const duplicate = dataset.find((item) => item.question.trim().toLowerCase() === normalized);
  if (duplicate) {
    console.error(`Question already exists as ${duplicate.id}; nothing to do.`);
    process.exit(1);
  }

  const keywords = (arg('keywords') || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const doc = arg('doc');
  const expectedNoAnswer = flag('no-answer');

  const entry: GoldenCase = {
    id: `badcase-${Date.now()}`,
    category: arg('category') || 'bad_case',
    question: question.trim(),
    expected_kb_scope: arg('scope') ? [arg('scope') as string] : [],
    expected_document_titles: doc ? [doc] : [],
    expected_keywords: keywords,
    expected_no_answer: expectedNoAnswer,
    requires_auth_user: arg('auth-user') || null,
    unauthorized_users: arg('unauthorized-user') ? [arg('unauthorized-user') as string] : [],
    notes: [
      'Auto-ingested from a user-flagged bad case.',
      arg('answer') ? `Flagged answer: ${arg('answer')!.slice(0, 500)}` : '',
      arg('trace') ? `Trace: ${arg('trace')}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };

  dataset.push(entry);
  fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2) + '\n');
  console.log(`Ingested bad case ${entry.id} into golden-dataset.json (total ${dataset.length}).`);
}

main();
