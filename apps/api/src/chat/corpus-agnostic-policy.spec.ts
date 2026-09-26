import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Policy guard for AGENTS.md §2: retrieval, semantic alignment and prompt
 * construction must stay corpus-agnostic. No department, scenario or customer of
 * the deploying organisation may be encoded in application code.
 *
 * The system prompt used to carry worked examples taken from one customer's
 * business (a specific company name, a lodging allowance, attendance rules,
 * performance-record wording). Those examples bias every deployment towards one
 * industry, and they leak the evaluation corpus into the product. This test
 * fails the build if such a term is reintroduced anywhere in the API source.
 */
const BANNED_BUSINESS_TOKENS = [
  '中通服',
  '差旅住宿标准',
  '450元',
  '花名册',
  '考勤规定',
  '考勤管理制度',
  '作息时间',
  '绩效为B',
  // Industry nouns must not seed retrieval heuristics either: the decomposition
  // subject lexicon used to hardcode a specific device ("无人机") which biased
  // sub-query planning towards one industry's corpus. Document-form nouns
  // (条例/规范/办法…) are generic and remain allowed.
  '无人机',
];

function sourceFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    // Specs may quote the offending text when asserting it is rejected.
    if (entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('corpus-agnostic policy', () => {
  it('keeps business-scenario examples out of the API source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(__dirname)) {
      const content = readFileSync(file, 'utf8');
      for (const token of BANNED_BUSINESS_TOKENS) {
        if (content.includes(token)) offenders.push(`${file.split('/src/')[1]}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
