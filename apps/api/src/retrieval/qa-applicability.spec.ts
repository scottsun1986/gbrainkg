import { resolveQaApplicability } from './qa-applicability';
describe('QA applicability without business-specific branches',()=>{
  const candidates=[{id:'a',kbId:'kb',qa:{question:'same question',answer:'first',scope:'Region Alpha',language:'en'}},{id:'b',kbId:'kb',qa:{question:'same question',answer:'second',scope:'Region Beta',language:'en'}}];
  it('asks for context rather than choosing contradictory scoped answers',()=>{
    const result=resolveQaApplicability(candidates,'same question');expect(result.allowed.size).toBe(0);expect(result.ambiguities[0].scopes).toEqual(['Region Alpha','Region Beta']);
  });
  it('matches an explicit generic scope label and deduplicates equal authority',()=>{
    expect([...resolveQaApplicability(candidates,'same question in Region Beta').allowed]).toEqual(['b']);
    expect([...resolveQaApplicability([{...candidates[0],qa:{question:'q',answer:'one'}},{...candidates[1],qa:{question:'q',answer:'one'}}],'q').allowed]).toEqual(['a','b']);
  });
});
