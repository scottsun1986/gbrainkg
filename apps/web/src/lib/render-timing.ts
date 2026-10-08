/** Observes a visible rendering opportunity after Markdown mounts, not physical paint. */
export function observeAnswerVisibility(root: HTMLElement, onVisible: (at: number) => void): () => void {
  let stopped = false;
  let firstFrame = 0; let secondFrame = 0;
  let intersecting = false;
  let target: Element | null = null;
  const ready = () => !stopped && document.visibilityState === 'visible' && intersecting
    && Boolean(root.querySelector('.answer-markdown')?.textContent?.trim());
  function check(): void {
    const nextTarget = root.querySelector('.answer-markdown');
    if (nextTarget !== target) {
      if (target) intersection.unobserve(target);
      target = nextTarget; intersecting = false;
      if (target) intersection.observe(target);
    }
    if (!ready() || firstFrame || secondFrame) return;
    firstFrame = requestAnimationFrame(() => {
      firstFrame = 0;
      secondFrame = requestAnimationFrame(() => {
        secondFrame = 0;
        if (ready()) {
          onVisible(performance.now()); stopped = true;
          intersection.disconnect(); mutations.disconnect(); document.removeEventListener('visibilitychange', check);
        }
      });
    });
  }
  const intersection = new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.isIntersecting); check();
  });
  const mutations = new MutationObserver(check);
  mutations.observe(root, { childList: true, subtree: true, characterData: true });
  document.addEventListener('visibilitychange', check); check();
  return () => {
    stopped = true; cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame);
    intersection.disconnect(); mutations.disconnect(); document.removeEventListener('visibilitychange', check);
  };
}
