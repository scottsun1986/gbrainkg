"use client";

import React, { memo, useMemo } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import type { Citation } from '@/types';

// React escapes every text node. Model HTML is displayed literally, never executed.
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? raw;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
}

function plainInlineText(tokens: Token[]): string {
  return tokens.map(token => {
    if ('tokens' in token && token.tokens) return plainInlineText(token.tokens);
    if (token.type === 'br') return ' ';
    return decodeEntities('text' in token ? String(token.text) : token.raw);
  }).join('');
}

function safeLink(raw: string): string | undefined {
  const href = decodeEntities(raw).trim();
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^(?:\/(?!\/)|#)/.test(href) && !/[\\\u0000-\u0020]/.test(href)) return href;
  return undefined;
}

// Some model streams attach a heading directly to the preceding sentence.
// Repair text-token boundaries only; code, links and escaped markers stay literal.
function answerTokens(content: string): Token[] {
  const tokens = marked.lexer(content, { gfm: true, breaks: true });
  let changed = false;
  const repair = (token: Token): string => {
    if (token.type === 'list') {
      let raw = token.raw;
      for (const item of token.items) {
        let itemRaw = item.raw;
        for (const child of item.tokens) itemRaw = itemRaw.replace(child.raw, repair(child));
        raw = raw.replace(item.raw, itemRaw);
      }
      return raw;
    }
    if ((token.type !== 'paragraph' && token.type !== 'text') || !token.tokens) return token.raw;
    const paragraph = token.tokens.map((item, index, siblings) => {
      // Bold is reserved for standalone labels. A bold run that opens a block
      // (start of the paragraph, or after a sentence boundary / citation
      // marker / hard break, and followed by a colon or the line end) is a
      // label: give it its own paragraph. Any other bold run is inline
      // emphasis, which the answer format does not use, so drop the markers.
      if (item.type === 'strong') {
        const before = siblings[index - 1];
        const after = siblings[index + 1];
        const endsClaim = !before || before.type === 'br'
          || (before.type === 'text' && /(?:[。！？；;.!?]|\[\d+\])\s*$/.test(before.raw));
        const opensBlock = !after || after.type === 'br' || /^\s*(?:\n|[：:])/.test(after.raw);
        if (opensBlock && (index === 0 || endsClaim)) {
          if (index === 0) return item.raw;
          changed = true;
          return `\n\n${item.raw}`;
        }
        changed = true;
        return item.raw.replace(/\*\*/g, '');
      }
      if (item.type !== 'text') return item.raw;
      return item.raw.replace(/([。！？.!?])(?= {0,3}#{1,6}[ \t]+\S)/g, (_match, punctuation: string) => {
        changed = true;
        return `${punctuation}\n\n`;
      });
    }).join('');
    return token.raw.replace(token.text, paragraph);
  };
  const repaired = tokens.map(repair).join('');
  return changed ? marked.lexer(repaired, { gfm: true, breaks: true }) : tokens;
}

type Props = {
  content: string;
  sources?: Citation[];
  activeCitation?: number | null;
  onCitation?: (source: Citation, index: number) => void;
  streaming?: boolean;
};

export const AnswerMarkdown = memo(function AnswerMarkdown({ content, sources = [], activeCitation, onCitation, streaming }: Props) {
  // Changing citations/selection never reparses a completed answer. Streaming uses
  // the same grammar as history, including incomplete fences and list items.
  const tokens = useMemo(() => answerTokens(content), [content]);
  const references = new Map(sources.map(source => [Number(source.citationIndex), source]));
  function text(value: string, key: string, cite = true): React.ReactNode {
    const decoded = decodeEntities(value);
    if (!cite) return decoded;
    return decoded.split(/(\[\d+\])/g).map((part, index) => {
      const match = /^\[(\d+)\]$/.exec(part);
      const number = match ? Number(match[1]) : 0;
      const source = references.get(number);
      return source ? <button key={`${key}-${index}`} type="button" className={`cite-chip${activeCitation === number ? ' active' : ''}`} title={source.title} aria-label={`查看来源 ${number}：${source.title}`} onClick={() => onCitation?.(source, number)}>{number}</button> : part;
    });
  }
  function render(items: Token[], prefix = 'md', inline = false, cite = true): React.ReactNode[] {
    return items.map((token, index) => {
      const key = `${prefix}-${index}`;
      const children = () => render('tokens' in token ? token.tokens || [] : [], key, true, cite);
      switch (token.type) {
        case 'space': case 'def': case 'checkbox': return null;
        case 'heading': {
          const heading = token as Tokens.Heading;
          return React.createElement(`h${heading.depth}`, { key }, children());
        }
        case 'paragraph': return <p key={key}>{children()}</p>;
        case 'text': return token.tokens ? <React.Fragment key={key}>{children()}</React.Fragment> : <React.Fragment key={key}>{text(token.text, key, cite)}</React.Fragment>;
        case 'escape': return <React.Fragment key={key}>{text(token.text, key, false)}</React.Fragment>;
        case 'strong': return <strong key={key}>{children()}</strong>;
        case 'em': return <em key={key}>{children()}</em>;
        case 'del': return <del key={key}>{children()}</del>;
        case 'br': return <br key={key} />;
        case 'hr': return <hr key={key} />;
        case 'codespan': return <code key={key}>{decodeEntities(token.text)}</code>;
        case 'code': return <div className="answer-code" key={key}>{token.lang && <div className="answer-code-language">{token.lang.split(/\s/)[0]}</div>}<pre tabIndex={0} aria-label="代码块"><code>{token.text}</code></pre></div>;
        case 'blockquote': return <blockquote key={key}>{render(token.tokens || [], key)}</blockquote>;
        case 'list': {
          const list = token as Tokens.List;
          const entries = list.items.map((item, i) => <li key={`${key}-${i}`}>{item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label={item.checked ? '已完成' : '未完成'} />}{render(item.tokens, `${key}-${i}`)}</li>);
          return list.ordered ? <ol key={key} start={Number(list.start) || 1}>{entries}</ol> : <ul key={key}>{entries}</ul>;
        }
        case 'table': {
          const table = token as Tokens.Table;
          const stacked = table.header.length > 6 || (table.header.length > 2 && table.rows.some(row => row.some(cell => cell.text.length > 160)));
          return <div key={key} className={`answer-table-scroll${table.header.length > 2 ? ' answer-table-multi' : ''}${stacked ? ' answer-table-stacked' : ''}`} role="region" aria-label="回答表格"><table role="table"><thead role="rowgroup"><tr role="row">{table.header.map((cell, i) => <th key={i} role="columnheader" scope="col" style={{ textAlign: table.align[i] || undefined }}>{render(cell.tokens, `${key}-h${i}`, true)}</th>)}</tr></thead><tbody role="rowgroup">{table.rows.map((row, r) => <tr key={r} role="row">{row.map((cell, c) => <td key={c} role="cell" style={{ textAlign: table.align[c] || undefined }}><span className="answer-cell-label" aria-hidden="true">{plainInlineText(table.header[c]?.tokens || [])}</span><span className="answer-cell-value">{render(cell.tokens, `${key}-${r}-${c}`, true)}</span></td>)}</tr>)}</tbody></table></div>;
        }
        case 'link': {
          const href = safeLink(token.href);
          // A source number inside a normal Markdown link is not a nested button.
          const label = render(token.tokens || [], key, true, false);
          return href ? <a key={key} href={href} title={token.title || undefined} target="_blank" rel="noopener noreferrer">{label}</a> : <React.Fragment key={key}>{label}</React.Fragment>;
        }
        case 'image': return <span key={key} className="answer-image-alt">{token.text ? `图片：${decodeEntities(token.text)}` : '图片'}</span>;
        case 'html': return inline ? <React.Fragment key={key}>{token.text}</React.Fragment> : <p key={key}>{token.text}</p>;
        default: return <React.Fragment key={key}>{text(token.raw || '', key, false)}</React.Fragment>;
      }
    });
  }
  return <div className="answer answer-markdown">{render(tokens)}{streaming && <span className="cursor" aria-label="正在生成回答" />}</div>;
});
