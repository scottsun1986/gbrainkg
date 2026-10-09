/** Application-owned publication gate, independent of conversion engine success. */
import { detectLanguage, scanPii, simhash64, tokenizeForSimhash } from './content-dedupe';

export const QUALITY_RULE_VERSION = 'content-v3';

/** SimHash over fewer tokens is high-variance: unrelated short documents can
 *  collide within the Hamming<=3 near-duplicate threshold by chance. Documents
 *  below this token count are excluded from the near-duplicate gate. */
const MIN_SIMHASH_TOKENS = 200;

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
export interface QualityAssessment {
  quality_status: QualityStatus;
  quality_score: number;
  quality_issues: string[];
  quality_rule_version: string;
  quality_metrics: {
    characters: number; meaningful_characters: number; projected_characters: number;
    native_text_chars: number; generated_text_chars: unknown; coverage: unknown;
    replacement_ratio: number; control_ratio: number; image_placeholders: number;
  };
}

/**
 * Publication gate. Per operator decision (option D), the ONLY hard stop is
 * "no extractable text". Encoding damage, OCR confidence, PII, clause
 * numbering, table shape, page coverage, and residual image placeholders are
 * recorded as metrics/issues for observability but never block publication.
 */
export function assessContentQuality(markdown: string, suffix: string, facts: Record<string, unknown> = {}): QualityAssessment {
  const chars = Array.from(markdown);
  const count = chars.length || 1;
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const projectedMeaningful = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  const nativeCount = facts.native_text_chars;
  const meaningful = typeof nativeCount === "number" && Number.isFinite(nativeCount) ? Math.max(0, nativeCount) : projectedMeaningful;
  const replacementRatio = (markdown.match(/\ufffd/g) || []).length / count;
  const controlRatio = (markdown.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) || []).length / count;
  const placeholders = (markdown.match(/<!--\s*(?:image|picture|figure)(?:[^\n>]*)\s*-->/gi) || []).length;

  // Informational notes only — these no longer gate publication.
  const issues: string[] = [];
  if (!meaningful) issues.push('没有提取到可检索文字');
  const coverage = facts.coverage as any;
  if (coverage?.failed > 0 || coverage?.skipped > 0) issues.push(`存在未覆盖来源单元：失败 ${coverage.failed || 0}、跳过 ${coverage.skipped || 0}`);
  if (replacementRatio > 0) issues.push('存在编码替换字符');
  if (placeholders) issues.push('仍有未识别图片占位符');
  if (facts.ocr_error) issues.push('OCR 存在失败，请查看覆盖信息');

  let score = 1 - Math.min(replacementRatio * 4, 0.45) - Math.min(controlRatio * 2, 0.2);
  if (facts.ocr_average_confidence !== undefined && facts.ocr_average_confidence !== null) {
    const raw = facts.ocr_average_confidence;
    const confidence = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
      score = Math.min(score, confidence);
    }
  }

  // Only empty extraction rejects. Everything else publishes.
  const status: QualityStatus =
    !meaningful || facts.quality_status === 'rejected'
      ? 'rejected'
      : 'passed';
  return {
    quality_status: status,
    quality_score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    quality_issues: [...new Set(issues)].slice(0, 20),
    quality_rule_version: QUALITY_RULE_VERSION,
    quality_metrics: {
      characters: chars.length, meaningful_characters: meaningful, projected_characters: projectedMeaningful,
      native_text_chars: meaningful, generated_text_chars: facts.generated_text_chars || 0, coverage: coverage || null,
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
  // A 64-bit SimHash over a handful of tokens is high-variance: unrelated
  // short documents can collide within Hamming<=3 by chance. Skip the
  // near-duplicate signal entirely below the minimum token count — the
  // ingestion gate treats an empty simhash as "no comparison available".
  const simhash = tokenizeForSimhash(markdown).length >= MIN_SIMHASH_TOKENS
    ? '0x' + simhash64(markdown).toString(16)
    : '';
  return { language, piiFindings, simhash, issues: [], status: 'passed' };
}

