import { parseQaCsv, previewQaText, qaMarkdown, validateQa } from './qa-import';
import { indexableChunkText } from './chunk-text';
import { assessContentQuality } from './content-quality';

describe('native QA import and publication representation', () => {
  it('keeps quoted commas/newlines, escaped quotes and zero/false answers', () => {
    expect(parseQaCsv('q,a\r\n"a,b","one\ntwo"\r\n"quote""?",0')).toEqual([['q','a'],['a,b','one\ntwo'],['quote"?','0']]);
    const preview=previewQaText(Buffer.from('{"q":"zero?","a":0}\n{"q":"false?","a":false}\nnot-json'),'.jsonl',{question:'q',answer:'a'});
    expect(preview.rows.map(row=>row.answer)).toEqual(['0','false','']);
    expect(preview.errors).toContainEqual({line:3,error:'JSONL 行不是有效对象'});
  });
  it('returns fields before mapping and rejects every member of a conflict group', () => {
    expect(previewQaText(Buffer.from('q,a\nx,y'),'.csv',{}).fields).toEqual(['q','a']);
    const preview=previewQaText(Buffer.from('q,a\nx,first\nx,second'),'.csv',{question:'q',answer:'a'});
    expect(preview.validCount).toBe(0); expect(preview.rows.every(row=>row.errors.length)).toBe(true);
  });
  it('separates question-side indexing from a complete atomic answer', () => {
    const qa=validateQa({question:'primary',answer:'secret answer text',aliases:['alias'],id:'stable'}).record;
    const markdown=qaMarkdown(qa); expect(markdown).toContain(qa.answer);
    expect(indexableChunkText(markdown)).toBe('primary\nalias');
  });
  it('uses stable source keys and validates effective dates and source identities', () => {
    expect(validateQa({question:'same',answer:'A'}).record.id).toBe(validateQa({question:'same',answer:'B'}).record.id);
    expect(validateQa({question:'same',answer:'A',scope:'other'}).record.id).not.toBe(validateQa({question:'same',answer:'A'}).record.id);
    expect(validateQa({question:'x',answer:'y',sourceDocumentId:'../bad',effectiveFrom:'2026-10-10',effectiveTo:'2026-10-09'}).errors.length).toBeGreaterThanOrEqual(2);
  });
  it('rejects only generated page skeleton while permitting legitimate short facts', () => {
    expect(assessContentQuality('# Page 1\n未识别', '.pdf', {native_text_chars:0,generated_text_chars:12}).quality_status).toBe('rejected');
    expect(assessContentQuality('0','.csv',{native_text_chars:1,coverage:{total:2,processed:1,failed:1}}).quality_status).toBe('passed');
  });
  it('derives idProvided server-side so the overwrite guard cannot be bypassed', () => {
    // The guard that stops a reviewed answer being silently replaced keyed off
    // a client-supplied flag. Any caller that omitted it skipped the check, so
    // the flag is now computed from the validated input.
    expect(validateQa({question:'q',answer:'a',id:'stable:1'}).idProvided).toBe(true);
    expect(validateQa({question:'q',answer:'a'}).idProvided).toBe(false);
    expect(validateQa({question:'q',answer:'a',id:'   '}).idProvided).toBe(false);
    // A caller cannot lie its way past the guard with an unrelated flag.
    expect(validateQa({question:'q',answer:'a',idProvided:true}).idProvided).toBe(false);
    expect(validateQa({question:'q',answer:'a',idProvided:false}).idProvided).toBe(false);
  });
});
