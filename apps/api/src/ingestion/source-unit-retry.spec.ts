import { mergeSourceUnitRetry, normalizeSourceOffsets } from './source-unit-retry';

describe('partial source-unit retries', () => {
  const old={source_units:[{id:'page:1',status:'processed',markdown:'old first',native_text_chars:9},{id:'page:2',status:'processed',markdown:'keep second',native_text_chars:11}],assets:[{id:'asset',path:'doc/old'}],structured_tables:[{id:'table-unchanged',complete:true}]};
  it('replaces only requested projections and retains unselected facts/coverage',()=>{
    const value=mergeSourceUnitRetry('old first\n\nkeep second',old,{source_units:[{id:'page:1',status:'processed',markdown:'new first',native_text_chars:9},{id:'page:2',status:'skipped',markdown:''}],structured_tables:[{id:'table-unchanged',complete:false}]},['page:1']);
    expect(value.markdown).toBe('new first\n\nkeep second');expect(value.coverage).toEqual({total:2,processed:2,failed:0,skipped:0});expect(value.structured_tables[0].complete).toBe(true);
  });
  it('fails closed for missing/ambiguous units instead of publishing a truncated document',()=>{
    expect(()=>mergeSourceUnitRetry('old first\nold first',old,{source_units:[{id:'page:1',status:'processed',markdown:'new'}]},['page:1'])).toThrow('ambiguous');
    expect(()=>mergeSourceUnitRetry('old first',old,{source_units:[]},['page:1'])).toThrow('omitted');
  });
  it('does not duplicate reference-only region text',()=>{
    const value=mergeSourceUnitRetry('page text',{source_units:[{id:'r',status:'processed',reference_only:true,markdown:''}]},{source_units:[{id:'r',status:'processed',reference_only:true,markdown:''}]},['r']);
    expect(value.markdown).toBe('page text');
  });
  it('converts Python codepoint offsets to JS UTF16 including astral characters',()=>{
    const parsed=normalizeSourceOffsets({markdown:'A😀B',source_units:[{char_start:2,char_end:3}]});
    expect(parsed.source_units[0]).toMatchObject({char_start:3,char_end:4});
  });
  it('uses verified source offsets when two pages contain identical text',()=>{
    const prior={source_units:[{id:'a',status:'processed',markdown:'same',char_start:0,char_end:4},{id:'b',status:'processed',markdown:'same',char_start:6,char_end:10}]};
    expect(mergeSourceUnitRetry('same\n\nsame',prior,{source_units:[{id:'b',status:'processed',markdown:'new'}]},['b']).markdown).toBe('same\n\nnew');
  });
  it('keeps each repeated occurrence positioned after a length-changing retry',()=>{
    const prior={source_units:[{id:'a',status:'processed',markdown:'same',char_start:0,char_end:4},{id:'b',status:'processed',markdown:'same',char_start:6,char_end:10},{id:'c',status:'processed',markdown:'same',char_start:12,char_end:16}]};
    const result=mergeSourceUnitRetry('same\n\nsame\n\nsame',prior,{source_units:[{id:'a',status:'processed',markdown:'long replacement'}]},['a']);
    expect(result.source_units[1]).toMatchObject({char_start:18,char_end:22});
    expect(result.source_units[2]).toMatchObject({char_start:24,char_end:28});
    expect(mergeSourceUnitRetry(result.markdown,result,{source_units:[{id:'c',status:'processed',markdown:'third'}]},['c']).markdown).toBe('long replacement\n\nsame\n\nthird');
  });
});
