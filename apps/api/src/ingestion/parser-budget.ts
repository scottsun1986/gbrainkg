/** Include native parsing, OCR, and polling overhead in the caller deadline. */
export function parserPollBudget(env: Record<string, string | undefined>): number {
  const positive = (value: string | undefined, fallback: number) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const nativeMs = positive(env.DOCLING_TIMEOUT_SECONDS, 240) * 1000;
  const ocrMs = positive(env.OCR_TIMEOUT_SECONDS, 900) * 1000;
  return Math.max(nativeMs + ocrMs + 60_000, positive(env.PARSER_POLL_TIMEOUT_MS, 1_200_000));
}
