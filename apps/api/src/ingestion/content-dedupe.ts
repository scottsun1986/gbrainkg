/**
 * 近重复检测（SimHash 64-bit）+ PII 扫描 + 语言检测。
 * Corpus-agnostic：不依赖业务词表。
 */
export function tokenizeForSimhash(text: string): string[] {
  const tokens: string[] = [];
  const latin = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  tokens.push(...latin);
  const cjk = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export function simhash64(text: string): bigint {
  const tokens = tokenizeForSimhash(text);
  if (tokens.length === 0) return 0n;
  const bits = new Array<number>(64).fill(0);
  for (const token of tokens) {
    let h = 0n;
    for (let i = 0; i < token.length; i++) {
      h = (h * 131n + BigInt(token.charCodeAt(i))) & 0xffffffffffffffffn;
    }
    for (let i = 0; i < 64; i++) {
      bits[i] += h & (1n << BigInt(i)) ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (bits[i] > 0) out |= 1n << BigInt(i);
  return out;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** 汉明距离 ≤3 视为近重复（经验阈值，64-bit SimHash）。 */
export function isNearDuplicate(a: bigint, b: bigint, threshold = 3): boolean {
  return hammingDistance(a, b) <= threshold;
}

export interface PiiFinding {
  kind: 'email' | 'phone_cn' | 'id_cn' | 'bank_card';
  match: string;
  index: number;
}

const PII_PATTERNS: Array<{ kind: PiiFinding['kind']; re: RegExp }> = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'phone_cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'id_cn', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: 'bank_card', re: /(?<!\d)\d{16,19}(?!\d)/g },
];

export function scanPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const { kind, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      findings.push({ kind, match: m[0], index: m.index });
    }
  }
  return findings;
}

export function redactPii(text: string): { text: string; findings: PiiFinding[] } {
  const findings = scanPii(text);
  let out = text;
  // 从后往前替换，避免 index 位移
  for (const f of [...findings].sort((a, b) => b.index - a.index)) {
    const mask = `[REDACTED:${f.kind}]`;
    out = out.slice(0, f.index) + mask + out.slice(f.index + f.match.length);
  }
  return { text: out, findings };
}

/** 轻量语言检测：CJK 比例 + 常见英文词。 */
export function detectLanguage(text: string): 'zh' | 'en' | 'mixed' | 'unknown' {
  const sample = text.slice(0, 2000);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const total = cjk + latin;
  if (total < 10) return 'unknown';
  const zhRatio = cjk / total;
  if (zhRatio > 0.7) return 'zh';
  if (zhRatio < 0.15) return 'en';
  return 'mixed';
}
