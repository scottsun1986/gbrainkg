import { parserPollBudget } from './parser-budget';
describe('parser deadline budget', () => {
  it('covers default native and OCR stages with polling overhead', () => {
    expect(parserPollBudget({})).toBe(1_200_000);
  });
  it('cannot expire before configured OCR and native stages', () => {
    expect(parserPollBudget({ OCR_TIMEOUT_SECONDS: '1800', PARSER_POLL_TIMEOUT_MS: '30000' })).toBe(2_100_000);
  });
  it('rejects invalid numeric configuration by using safe defaults', () => {
    expect(parserPollBudget({ OCR_TIMEOUT_SECONDS: 'NaN', DOCLING_TIMEOUT_SECONDS: '-1', PARSER_POLL_TIMEOUT_MS: 'Infinity' })).toBe(1_200_000);
  });
});
