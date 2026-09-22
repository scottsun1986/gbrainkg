import { ShadowRetrievalService } from './shadow-retrieval.service';
import { AbExperimentService } from './ab-experiment.service';

describe('ShadowRetrievalService wiring helpers', () => {
  it('compare returns control when experiment disabled', async () => {
    const ab = new AbExperimentService({
      'retrieval.fusion': {
        key: 'retrieval.fusion',
        sampleRate: 0,
        treatmentRate: 0,
        shadowRate: 0,
        enabled: false,
      },
    });
    const shadow = new ShadowRetrievalService(ab);
    const fn = jest.fn(async () => ({ citations: [] }));
    const out = await shadow.compare('retrieval.fusion', 'u1', 's1', 'q', {} as any, fn);
    expect(out.result).toEqual({ citations: [] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.shadowDiff).toBeUndefined();
  });
});
