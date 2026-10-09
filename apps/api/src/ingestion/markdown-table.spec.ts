import { isMarkdownTableDelimiter, parseMarkdownTableCells } from './markdown-table';
describe('Markdown table cells', () => {
  it('keeps escaped pipes and code spans in their original column', () => {
    expect(parseMarkdownTableCells('| a\\|b | `x|y` | ``a`|b`` | 0 | false |')).toEqual(['a|b', '`x|y`', '``a`|b``', '0', 'false']);
  });
  it('keeps empty columns, optional outer pipes and unmatched ticks', () => {
    expect(parseMarkdownTableCells(' a | | b ')).toEqual(['a', '', 'b']);
    expect(parseMarkdownTableCells('| a | |')).toEqual(['a', '']);
    expect(parseMarkdownTableCells('| `unclosed | b |')).toEqual(['`unclosed', 'b']);
    expect(parseMarkdownTableCells('a \\|')).toEqual(['a |']);
  });
  it('distinguishes a literal backslash followed by a column separator', () => {
    expect(parseMarkdownTableCells('| a\\\\| b |')).toEqual(['a\\', 'b']);
  });
  it('validates every delimiter column instead of searching for three dashes', () => {
    expect(isMarkdownTableDelimiter('| :--- | ---: | :---: |')).toBe(true);
    expect(isMarkdownTableDelimiter('| text--- | --- |')).toBe(false);
    expect(isMarkdownTableDelimiter('| `---|---` |')).toBe(false);
  });
});
