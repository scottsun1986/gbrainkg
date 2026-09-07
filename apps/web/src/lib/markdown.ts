import DOMPurify from 'dompurify';
import { marked } from 'marked';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderPlainText(content: string, phrases: unknown[] = []): string {
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') return escapeHtml(content);
  return sanitizeAndHighlight(escapeHtml(content), phrases);
}

/** Render untrusted documents; highlighting only ever modifies text nodes. */
export function renderMarkdown(content: string, phrases: unknown[] = []): string {
  if (!content) return '<p>暂无结构化解析内容</p>';
  // SSR has no DOM. Fail closed until the browser can sanitize the document.
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    return `<pre>${escapeHtml(content)}</pre>`;
  }
  let html: string;
  try {
    html = marked.parse(content, { async: false });
  } catch {
    html = `<pre>${escapeHtml(content)}</pre>`;
  }
  return sanitizeAndHighlight(html, phrases);
}

function sanitizeAndHighlight(html: string, phrases: unknown[]): string {
  const options = {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'mark', 'sup', 'sub', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'class', 'start'],
    ALLOW_DATA_ATTR: false,
  };
  const container = document.createElement('div');
  container.innerHTML = DOMPurify.sanitize(html, options);
  const terms = [...new Set(phrases.map(String).map(value => value.trim()).filter(Boolean))]
    .slice(0, 50).sort((a, b) => b.length - a.length);
  if (terms.length) {
    const pattern = new RegExp(terms.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|'), 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of text.matchAll(pattern)) {
        fragment.append(document.createTextNode(text.slice(offset, match.index)));
        const mark = document.createElement('mark');
        mark.className = 'doc-citation-highlight';
        mark.textContent = match[0];
        fragment.append(mark);
        offset = match.index + match[0].length;
      }
      if (offset) {
        fragment.append(document.createTextNode(text.slice(offset)));
        node.replaceWith(fragment);
      }
    }
  }
  return DOMPurify.sanitize(container.innerHTML, options);
}
