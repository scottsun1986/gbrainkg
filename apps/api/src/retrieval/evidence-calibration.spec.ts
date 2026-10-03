import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateRerankScore } from './evidence-calibration';
import * as fs from 'node:fs';

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
  it('reads an unchanged file once and invalidates replacement or deletion immediately', () => {
    const path = join(directory, 'cached.json');
    process.env.RERANK_CALIBRATION_FILE = path;
    const profile = { contract: 'rerank-platt-v1', route: 'route', model: 'model', revision: 'rev', corpusHash: 'corpus', validationSetHash: 'validation', sampleCount: 200, slope: 2, intercept: 0 };
    writeFileSync(path, JSON.stringify(profile));
    const reads = jest.spyOn(fs, 'readFileSync');
    try {
      for (let i = 0; i < 100; i++) expect(calibrateRerankScore(0, 'route', 'model', 'rev')).toBe(.5);
      expect(reads).toHaveBeenCalledTimes(1);
      const replacement = join(directory, 'replacement.json');
      writeFileSync(replacement, JSON.stringify({ ...profile, intercept: 1 }));
      fs.renameSync(replacement, path);
      expect(calibrateRerankScore(0, 'route', 'model', 'rev')).toBeCloseTo(.7310586);
      expect(reads).toHaveBeenCalledTimes(2);
      rmSync(path);
      expect(calibrateRerankScore(0, 'route', 'model', 'rev')).toBeNull();
    } finally { reads.mockRestore(); }
  });
  it.each([undefined, null, '200', 200.5])('rejects an unverified sample count %s', sampleCount => {
    const path = join(directory, 'invalid.json'); process.env.RERANK_CALIBRATION_FILE = path;
    writeFileSync(path, JSON.stringify({ contract: 'rerank-platt-v1', route: 'route', model: 'model', revision: 'rev', corpusHash: 'corpus', validationSetHash: 'validation', sampleCount, slope: 2, intercept: 0 }));
    expect(calibrateRerankScore(0, 'route', 'model', 'rev')).toBeNull();
  });
});
