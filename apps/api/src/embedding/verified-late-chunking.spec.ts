import { createHash } from 'node:crypto';
import { sharedWindows, validateLateCapability, validateLateOutput } from './verified-late-chunking';
const capability = { contract:'shared-context-pooling-v1', revision:'weights1', tokenizerRevision:'tokens1', model:'bge-m3', dimensions:1024, offsetUnit:'utf16', maxChars:1024 } as const;
it('requires immutable weights, tokenizer, dimensions and exact offset units', () => {
  expect(validateLateCapability(capability,'weights1')).toEqual(capability);
  expect(() => validateLateCapability({...capability,offsetUnit:'tokens'},'weights1')).toThrow(/contract/);
  expect(() => validateLateCapability(capability,'weights2')).toThrow(/contract/);
});
it('pools actual shared raw text and rejects truncation, offset drift and fabricated vectors', () => {
  const text='甲😀乙\n共享上下文', blocks=[{ id:'b',charStart:0,charEnd:text.length }];
  const result:any={ revision:'weights1',sharedContext:true,truncated:false,windowHash:createHash('sha256').update(text).digest('hex'),blocks:[{ ...blocks[0],embedding:Array(1024).fill(.01),tokenOffsets:[[0,text.length]] }] };
  expect(validateLateOutput(result,capability,text,blocks)).toHaveLength(1);
  expect(() => validateLateOutput({...result,truncated:true},capability,text,blocks)).toThrow(/Unverified/);
  expect(() => validateLateOutput({...result,blocks:[{...result.blocks[0],charEnd:2}]},capability,text,blocks)).toThrow(/offset/);
  expect(sharedWindows('a'.repeat(2500),[{id:'a',charStart:0,charEnd:700},{id:'b',charStart:1100,charEnd:1800}],1024)).toHaveLength(2);
  expect(() => sharedWindows('text',[{id:'b',charStart:0,charEnd:50}],1024)).toThrow(/offset/);
});
