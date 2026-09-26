/** Application-owned publication gate, independent of conversion engine success. */
import { detectLanguage, scanPii, simhash64 } from './content-dedupe';

export const QUALITY_RULE_VERSION = 'content-v2';

function parseChineseNumber(str: string): number {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const map: Record<string, number> = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const units: Record<string, number> = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
  
  let result = 0;
  let section = 0;
  let number = 0;
  let hasNumber = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (map[c] !== undefined) {
      number = map[c];
      hasNumber = true;
    } else if (units[c] !== undefined) {
      const unit = units[c];
      if (!hasNumber && unit === 10) number = 1;
      if (unit === 10000) {
        section = (section + number) * unit;
        result += section;
        section = 0;
      } else {
        section += number * unit;
      }
      number = 0;
      hasNumber = false;
    }
  }
  result += section + number;
  return result;
}
export type QualityStatus = 'passed' | 'needs_review' | 'rejected';

/**
 * Publication gate. Per operator decision (option D), the ONLY hard stop is
 * "no extractable text". Encoding damage, OCR confidence, PII, clause
 * numbering, table shape, page coverage, and residual image placeholders are
 * recorded as metrics/issues for observability but never block publication.
 */
export function assessContentQuality(markdown: string, suffix: string, facts: Record<string, unknown> = {}) {
  const chars = Array.from(markdown);
  const count = chars.length || 1;
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const meaningful = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  const replacementRatio = chars.filter(c => c === '\ufffd').length / count;
  const controlRatio = chars.filter(c => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c)).length / count;
  const placeholders = (markdown.match(/<!--\s*(?:image|picture|figure)(?:[^\n>]*)\s*-->/gi) || []).length;

  // Informational notes only — these no longer gate publication.
  const issues: string[] = [];
  if (!meaningful) issues.push('没有提取到可检索文字');

  let score = 1 - Math.min(replacementRatio * 4, 0.45) - Math.min(controlRatio * 2, 0.2);
  if (facts.ocr_average_confidence !== undefined && facts.ocr_average_confidence !== null) {
    const raw = facts.ocr_average_confidence;
    const confidence = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
      score = Math.min(score, confidence);
    }
  }

  // Only empty extraction rejects. Everything else publishes.
  const status: QualityStatus = !meaningful || facts.quality_status === 'rejected' ? 'rejected' : 'passed';
  return {
    quality_status: status,
    quality_score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    quality_issues: [...new Set(issues)].slice(0, 20),
    quality_rule_version: QUALITY_RULE_VERSION,
    quality_metrics: {
      characters: chars.length, meaningful_characters: meaningful,
      replacement_ratio: replacementRatio, control_ratio: controlRatio,
      image_placeholders: placeholders,
    },
  };
}

// ---------- 扩展质量信息：语言 / 近重复（PII 不再作为门禁） ----------

export const QUALITY_RULE_VERSION_EXT = 'content-v2.1';

export interface ExtendedQualityResult {
  language: string;
  piiFindings: ReturnType<typeof scanPii>;
  simhash: string;
  issues: string[];
  status: QualityStatus;
}

/**
 * Language + simhash for near-dup detection. PII is still scanned for
 * metadata only and NEVER blocks publication (operator policy).
 */
export function assessExtendedQuality(markdown: string): ExtendedQualityResult {
  const language = detectLanguage(markdown);
  const piiFindings = scanPii(markdown);
  const simhash = '0x' + simhash64(markdown).toString(16);
  return { language, piiFindings, simhash, issues: [], status: 'passed' };
}

