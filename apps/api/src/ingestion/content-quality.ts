/** Application-owned publication gate, independent of conversion engine success. */
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

export function assessContentQuality(markdown: string, suffix: string, facts: Record<string, unknown> = {}) {
  const chars = Array.from(markdown);
  const count = chars.length || 1;
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const meaningful = (visible.match(/[\p{L}\p{N}]/gu) || []).length;
  const replacementRatio = chars.filter(c => c === '\ufffd').length / count;
  const controlRatio = chars.filter(c => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c)).length / count;
  const placeholders = (markdown.match(/<!--\s*(?:image|picture|figure)\s*-->/gi) || []).length;
  const binary = !['.md', '.txt', '.csv', '.html', '.htm'].includes(suffix.toLowerCase());
  const issues: string[] = [];
  if (!meaningful) issues.push('没有提取到可检索文字');
  if (binary && meaningful < 20) issues.push('提取文字过少，可能是空白文件或解析不完整');
  if (replacementRatio > 0.01) issues.push('存在较多字体编码替换字符');
  if (controlRatio > 0.02) issues.push('存在异常控制字符');
  if (placeholders && ['.pptx', '.png', '.jpg', '.jpeg'].includes(suffix.toLowerCase())) {
    issues.push('版面解析只返回图片占位符，图片文字尚未完成 OCR');
  }

  // 1. Clause Numbering Continuity Check
  const articleRegex = /第([一二三四五六七八九十百千万〇零两\d]+)条/g;
  const articles: { str: string; num: number }[] = [];
  let match;
  while ((match = articleRegex.exec(markdown)) !== null) {
    const str = match[1];
    const num = parseChineseNumber(str);
    articles.push({ str, num });
  }

  if (articles.length >= 3) {
    const seen = new Set<number>();
    let duplicateNumStr: string | null = null;
    
    for (const a of articles) {
      if (seen.has(a.num)) {
        duplicateNumStr = a.str;
        break;
      }
      seen.add(a.num);
    }

    if (duplicateNumStr) {
      issues.push(`存在重复的条款编号（如第${duplicateNumStr}条）`);
    }

    const sortedNums = [...new Set(articles.map(a => a.num))].sort((a, b) => a - b);
    let hasGap = false;
    for (let i = 1; i < sortedNums.length; i++) {
      if (sortedNums[i] - sortedNums[i - 1] > 10) {
        hasGap = true;
        break;
      }
    }
    if (hasGap) {
      issues.push('条款编号存在明显跳空断层');
    }
  }

  // 2. Table Structure Integrity Check
  const lines = markdown.split('\n');
  let inTable = false;
  let headerColCount = 0;
  let hasTableIssue = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('|')) {
      const getColCount = (l: string) => {
        let s = l.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').length;
      };
      
      if (!inTable) {
        const nextLine = (lines[i + 1] || '').trim();
        if (nextLine.includes('|') && /^[|\s\-:]+$/.test(nextLine)) {
          inTable = true;
          headerColCount = getColCount(line);
          i++; // Skip separator
        }
      } else {
        const rowColCount = getColCount(line);
        if (headerColCount >= 4 && rowColCount <= 1) {
          hasTableIssue = true;
        }
      }
    } else {
      inTable = false;
    }
  }
  
  if (hasTableIssue) {
    issues.push('检测到表格结构不完整或存在截断');
  }

  // 3. Page Coverage Ratio Check
  if (facts.page_count !== undefined) {
    const pageCount = Number(facts.page_count);
    if (pageCount > 1 && facts.text_pages !== undefined) {
      const textPages = Number(facts.text_pages);
      if (textPages / pageCount < 0.4) {
        issues.push(`页面文字覆盖率偏低 (${textPages}/${pageCount})，可能存在未识别的扫描页面`);
      }
    }
  }
  let score = 1 - Math.min(replacementRatio * 4, 0.45) - Math.min(controlRatio * 2, 0.2);
  if (binary && meaningful < 20) score -= 0.45;
  if (facts.ocr_average_confidence !== undefined && facts.ocr_average_confidence !== null) {
    const raw = facts.ocr_average_confidence;
    const confidence = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issues.push('OCR 置信度格式无效');
    } else {
      score = Math.min(score, confidence);
      if (confidence < 0.75) issues.push('OCR 平均置信度低于 0.75');
    }
  }
  // Engine warnings may make the decision stricter, never bypass this gate.
  if (Array.isArray(facts.quality_issues)) {
    issues.push(...facts.quality_issues.filter((v): v is string => typeof v === 'string').slice(0, 20));
  }
  let status: QualityStatus = issues.length || facts.quality_status === 'needs_review' ? 'needs_review' : 'passed';
  if (!meaningful || facts.quality_status === 'rejected') status = 'rejected';
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
