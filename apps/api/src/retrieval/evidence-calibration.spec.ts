import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateRerankScore } from './evidence-calibration';

describe('calibrated evidence confidence', () => {
  const before = process.env.RERANK_CALIBRATION_FILE;
  const directory = mkdtempSync(join(tmpdir(),'gbrain-calibration-'));
  afterAll(() => { rmSync(directory,{ recursive:true,force:true }); if (before === undefined) delete process.env.RERANK_CALIBRATION_FILE; else process.env.RERANK_CALIBRATION_FILE=before; });
  it('keeps confidence unknown without a held-out calibration profile', () => {
    delete process.env.RERANK_CALIBRATION_FILE;
    expect(calibrateRerankScore(.99,'route','model','rev')).toBeNull();
  });
  it('rejects incompatible models and insufficient samples, then applies the pinned calibration', () => {
    const path=join(directory,'profile.json');process.env.RERANK_CALIBRATION_FILE=path;
    const profile={ contract:'rerank-platt-v1',route:'route',model:'model',revision:'rev',corpusHash:'corpus',validationSetHash:'validation',sampleCount:200,slope:2,intercept:0 };
    writeFileSync(path,JSON.stringify(profile));
    expect(calibrateRerankScore(0,'route','model','other-rev')).toBeNull();
    expect(calibrateRerankScore(0,'route','model','rev')).toBe(.5);
    writeFileSync(path,JSON.stringify({ ...profile,sampleCount:199 }));
    expect(calibrateRerankScore(.99,'route','model','rev')).toBeNull();
  });
});
