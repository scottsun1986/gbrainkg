/**
 * Unit tests for pure/SSR-safe helpers in `src/lib/markdown.ts`.
 *
 * These exercise the no-DOM (node) code paths only: `renderPlainText` and
 * `renderMarkdown` fail closed to HTML-escaped text whenever `window` or
 * `DOMPurify.sanitize` is unavailable — exactly the situation under node:test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderPlainText, renderMarkdown } from '../src/lib/markdown';

describe('renderPlainText (SSR / no-DOM path)', () => {
  it('escapes HTML special characters', () => {
    assert.equal(
      renderPlainText('<b>x</b> & "y"'),
      '&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;',
    );
  });

  it('escapes single quotes', () => {
    assert.equal(renderPlainText("it's"), 'it&#39;s');
  });

  it('returns empty string for empty input', () => {
    assert.equal(renderPlainText(''), '');
  });

  it('ignores highlight phrases when DOM is unavailable (still escaped)', () => {
    const out = renderPlainText('alpha beta', ['alpha']);
    assert.equal(out, 'alpha beta');
    assert.ok(!out.includes('<mark'));
  });
});

describe('renderMarkdown (SSR / no-DOM path)', () => {
  it('returns a placeholder for empty content', () => {
    assert.equal(renderMarkdown(''), '<p>暂无结构化解析内容</p>');
    assert.equal(renderMarkdown(undefined as unknown as string), '<p>暂无结构化解析内容</p>');
  });

  it('fails closed to a pre-escaped <pre> block without a DOM', () => {
    const out = renderMarkdown('# heading <script>');
    assert.ok(out.startsWith('<pre>'));
    assert.ok(out.endsWith('</pre>'));
    assert.ok(out.includes('# heading &lt;script&gt;'));
    assert.ok(!out.includes('<script>'));
  });

  it('does not emit highlight marks without a DOM', () => {
    const out = renderMarkdown('alpha beta', ['alpha']);
    assert.ok(!out.includes('<mark'));
  });
});
