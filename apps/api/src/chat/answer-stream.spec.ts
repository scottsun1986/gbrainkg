import { IncrementalAnswerStreamer, StageReporter, collectStablePrefix } from './answer-stream';
import { tidyVerifiedAnswer } from './ordered-answer';

function fakeSubscriber() {
  const events: any[] = [];
  return {
    events,
    subscriber: { next: (e: any) => events.push(e), complete: () => undefined } as any,
  };
}

function firstChunk(rendered: string): string {
  return collectStablePrefix(rendered, '', 0).chunk;
}

describe('collectStablePrefix (tidy-invariant incremental chunking)', () => {
  it('emits complete stable lines and holds the pending tail', () => {
    const rendered = '第一句已验证。\n第二句已验证。\n正在生成的半';
    expect(firstChunk(rendered)).toBe('第一句已验证。\n第二句已验证。');
  });

  it('skips marker-only lines that tidy would drop', () => {
    const rendered = '结论甲[1]。\n[2]\n结论乙[3]。\n';
    const chunk = firstChunk(rendered);
    expect(chunk).toBe('结论甲[1]。\n结论乙[3]。');
    expect(tidyVerifiedAnswer(rendered).startsWith(chunk)).toBe(true);
  });

  it('collapses consecutive blanks to the single blank tidy keeps', () => {
    const rendered = '段落一。\n\n\n\n段落二。\n';
    const chunk = firstChunk(rendered);
    expect(chunk).toBe('段落一。\n\n段落二。');
    expect(tidyVerifiedAnswer(rendered).startsWith(chunk)).toBe(true);
  });

  it('holds an odd-bold line until tidy resolves it', () => {
    expect(firstChunk('正常句。\n**未闭合粗体\n后续句。\n')).toBe('正常句。');
  });

  it('holds a heading when it is the last complete line (tidy pops trailing headings)', () => {
    expect(firstChunk('## 标题')).toBe('');
    expect(firstChunk('## 标题\n正文。\n')).toBe('## 标题\n正文。');
  });

  it('streams fenced code blocks verbatim', () => {
    const rendered = '```ts\nconst x = **not-bold;\n```\n后文。\n';
    const chunk = firstChunk(rendered);
    expect(chunk).toBe(rendered.replace(/\n$/, ''));
    expect(tidyVerifiedAnswer(rendered).startsWith(chunk)).toBe(true);
  });

  it('extends the previously pushed prefix only', () => {
    const first = collectStablePrefix('第一行。\n', '', 0);
    expect(first.chunk).toBe('第一行。');
    const second = collectStablePrefix('第一行。\n第二行。\n', first.chunk, first.lineCount);
    expect(second.chunk).toBe('\n第二行。');
  });

  it('returns nothing when rendered diverges from the pushed prefix', () => {
    expect(collectStablePrefix('完全不同。\n', '旧的前缀。', 1).chunk).toBe('');
  });

  it('property: every emitted chunk is a byte-identical prefix of tidyVerifiedAnswer', () => {
    const samples = [
      '## 一、总则\n本制度适用于全体员工[1]。\n\n## 二、细则\n\n- 条款甲[2]。\n- 条款乙[3]。\n\n结论句。\n',
      '段落一。\n\n\n[1]\n\n段落二 **加粗** 收尾。\n',
      '| 表头 | 列二 |\n| --- | --- |\n| a | b |\n',
      '```python\nprint(1)\n```\n说明句[1]。\n**粗体**尾巴',
    ];
    for (const rendered of samples) {
      const chunk = firstChunk(rendered);
      if (chunk) expect(tidyVerifiedAnswer(rendered).startsWith(chunk)).toBe(true);
    }
  });
});

describe('IncrementalAnswerStreamer', () => {
  it('streams incrementally and finishFinal pushes only the remainder', () => {
    const { events, subscriber } = fakeSubscriber();
    const streamer = new IncrementalAnswerStreamer({ subscriber, enabled: true });
    streamer.offerRender('第一句。\n', []);
    streamer.offerRender('第一句。\n第二句。\n', []);
    streamer.finishFinal('第一句。\n第二句。\n结尾半句');
    const deltas = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content);
    expect(deltas.join('')).toBe('第一句。\n第二句。\n结尾半句');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
  });

  it('streams the verified prefix while later sentences are held', () => {
    const { events, subscriber } = fakeSubscriber();
    const streamer = new IncrementalAnswerStreamer({ subscriber, enabled: true });
    streamer.offerRender('第一句。\n第二句被扣留。\n', ['第二句被扣留。']);
    const deltas = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content);
    expect(deltas.join('')).toBe('第一句。');
    streamer.finishFinal('第一句。\n第二句被扣留。\n结尾。');
    const all = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content).join('');
    expect(all).toBe('第一句。\n第二句被扣留。\n结尾。');
  });

  it('buffers entirely while a sentence is held by the grounding gate', () => {
    const { events, subscriber } = fakeSubscriber();
    const streamer = new IncrementalAnswerStreamer({ subscriber, enabled: true });
    streamer.offerRender('第一句被扣留。\n', ['第一句被扣留。']);
    expect(events).toHaveLength(0);
    streamer.finishFinal('第一句被扣留。\n恢复句。\n');
    const deltas = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content);
    expect(deltas.join('')).toBe('第一句被扣留。\n恢复句。\n');
  });

  it('strict mode keeps the one-shot buffered contract', () => {
    const { events, subscriber } = fakeSubscriber();
    const streamer = new IncrementalAnswerStreamer({ subscriber, enabled: false });
    streamer.offerRender('第一句。\n', []);
    streamer.finishFinal('第一句。\n第二句。\n');
    const deltas = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content);
    expect(deltas).toEqual(['第一句。\n第二句。\n']);
  });

  it('incremental stream of a realistic answer reconstructs the tidied final exactly', () => {
    const { events, subscriber } = fakeSubscriber();
    const streamer = new IncrementalAnswerStreamer({ subscriber, enabled: true });
    // Simulate the ordered answer growing sentence by sentence.
    const growing = ['', '## 一、总则\n', '## 一、总则\n本制度适用于全体员工[1]。\n',
      '## 一、总则\n本制度适用于全体员工[1]。\n\n## 二、细则\n', '## 一、总则\n本制度适用于全体员工[1]。\n\n## 二、细则\n- 条款甲[2]。\n- 条款乙[3]。\n'];
    for (const rendered of growing) streamer.offerRender(rendered, []);
    const final = tidyVerifiedAnswer(growing[growing.length - 1]);
    streamer.finishFinal(final);
    const streamed = events.filter((e) => e.data.type === 'delta').map((e) => e.data.content).join('');
    expect(streamed).toBe(final);
  });
});

describe('StageReporter', () => {
  it('emits stage progress events the client can render', () => {
    const { events, subscriber } = fakeSubscriber();
    const reporter = new StageReporter({ subscriber });
    reporter.emit('retrieving', '混合检索');
    reporter.emit('reranking');
    const stages = events.filter((e) => e.data.type === 'stage').map((e) => e.data.stage);
    expect(stages).toEqual(['retrieving', 'reranking']);
  });
});
