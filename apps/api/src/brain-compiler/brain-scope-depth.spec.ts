import { resolveScopeCompileDepth } from './brain-scope.service';

describe('resolveScopeCompileDepth', () => {
  it('uses bounded defaults', () => {
    expect(resolveScopeCompileDepth({} as NodeJS.ProcessEnv)).toEqual({
      docChunkDepth: 40,
      synthesizeSourceLimit: 5,
    });
  });

  it('honours configured depth and source count', () => {
    expect(
      resolveScopeCompileDepth({
        BRAIN_SCOPE_DOC_CHUNKS: '80',
        BRAIN_SCOPE_SYNTHESIZE_SOURCES: '12',
      } as NodeJS.ProcessEnv),
    ).toEqual({ docChunkDepth: 80, synthesizeSourceLimit: 12 });
  });

  it('clamps pathological configuration to hard ceilings', () => {
    expect(
      resolveScopeCompileDepth({
        BRAIN_SCOPE_DOC_CHUNKS: '100000',
        BRAIN_SCOPE_SYNTHESIZE_SOURCES: '100000',
      } as NodeJS.ProcessEnv),
    ).toEqual({ docChunkDepth: 200, synthesizeSourceLimit: 50 });
  });

  it('falls back to defaults on invalid or non-positive values', () => {
    expect(resolveScopeCompileDepth({ BRAIN_SCOPE_DOC_CHUNKS: '0.5', BRAIN_SCOPE_SYNTHESIZE_SOURCES: '0.5' })).toEqual({ docChunkDepth: 40, synthesizeSourceLimit: 5 });
    expect(
      resolveScopeCompileDepth({
        BRAIN_SCOPE_DOC_CHUNKS: '0',
        BRAIN_SCOPE_SYNTHESIZE_SOURCES: '-3',
      } as NodeJS.ProcessEnv),
    ).toEqual({ docChunkDepth: 40, synthesizeSourceLimit: 5 });
    expect(
      resolveScopeCompileDepth({
        BRAIN_SCOPE_DOC_CHUNKS: 'nope',
      } as NodeJS.ProcessEnv),
    ).toEqual({ docChunkDepth: 40, synthesizeSourceLimit: 5 });
  });
});
