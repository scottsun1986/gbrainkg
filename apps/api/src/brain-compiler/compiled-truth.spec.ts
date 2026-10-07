import { compiledTimeline, compiledTruthDiff, withSynthesisTimeout } from './compiled-truth';

describe('compiled truth audit', () => {
  it('computes actual added/removed content and source version changes', () => {
    const diff = compiledTruthDiff('stable\nold', 'stable\nnew', [{ docId: 'a', version: 1 }, { docId: 'gone' }], [{ docId: 'a', version: 2 }, { docId: 'new' }]);
    expect(diff.addedLines).toEqual(['new']);
    expect(diff.removedLines).toEqual(['old']);
    expect(diff.sourcesChanged).toEqual(['a']);
    expect(diff.sourcesAdded).toEqual(['new']);
    expect(diff.sourcesRemoved).toEqual(['gone']);
    expect(diff.beforeHash).not.toBe(diff.afterHash);
  });
  it('marks missing baseline and preserves exact counts for bounded display', () => {
    const diff = compiledTruthDiff(null, Array.from({ length: 250 }, (_, i) => String(i)).join('\n'));
    expect(diff.baseline).toBe('missing');
    expect(diff.beforeHash).toBeNull();
    expect(diff.addedLineCount).toBe(250);
    expect(diff.displayTruncated).toBe(true);
    expect(diff.addedLines).toHaveLength(200);
  });
  it('reports lifecycle and explicit supersedes links without inventing repeal', () => {
    const timeline = compiledTimeline([{ id: 'a', title: 'Same V1', version: 1 }, { id: 'b', title: 'Same V2', version: 2, supersedesDocumentId: 'a' }]);
    expect(timeline).toContain('"supersedesDocumentId":"a"');
    expect(timeline).not.toContain('repealed');
  });
  it('removes timeout handles after both success and failure', async () => {
    jest.useFakeTimers();
    try {
      await expect(withSynthesisTimeout(Promise.resolve('ok'))).resolves.toBe('ok');
      expect(jest.getTimerCount()).toBe(0);
      await expect(withSynthesisTimeout(Promise.reject(new Error('unavailable')))).rejects.toThrow('unavailable');
      expect(jest.getTimerCount()).toBe(0);
      const pending = withSynthesisTimeout(new Promise(() => {}), 10);
      const rejected = expect(pending).rejects.toThrow('synthesis_timeout');
      jest.advanceTimersByTime(10);
      await rejected;
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
