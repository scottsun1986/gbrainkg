import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeAnswerVisibility } from '../src/lib/render-timing';

test('render timing waits for mounted Markdown, visibility, intersection and two frames', () => {
  const saved = Object.fromEntries(['document', 'IntersectionObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map<string, () => void>();
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  const doc = { visibilityState: 'hidden', addEventListener: (key: string, cb: () => void) => listeners.set(key, cb), removeEventListener: (key: string) => listeners.delete(key) };
  let mutate!: () => void; let intersect!: (entries: Array<{ isIntersecting: boolean }>) => void;
  Object.assign(globalThis, {
    document: doc,
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IntersectionObserver: class { constructor(cb: typeof intersect) { intersect = cb; } observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { constructor(cb: () => void) { mutate = cb; } observe() {} disconnect() {} },
  });
  let markdown: { textContent: string } | null = null;
  const root = { querySelector: () => markdown } as unknown as HTMLElement;
  const observed: number[] = [];
  const runFrame = () => { const entry = frames.entries().next().value as [number, FrameRequestCallback]; frames.delete(entry[0]); entry[1](0); };
  try {
    const cleanup = observeAnswerVisibility(root, at => observed.push(at));
    intersect([{ isIntersecting: true }]);
    assert.equal(frames.size, 0);
    markdown = { textContent: 'Actual answer' }; mutate(); intersect([{ isIntersecting: true }]);
    assert.equal(frames.size, 0);
    doc.visibilityState = 'visible'; listeners.get('visibilitychange')!();
    runFrame(); assert.equal(observed.length, 0);
    runFrame(); assert.equal(observed.length, 1);
    assert.equal(listeners.size, 0);
    cleanup();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
