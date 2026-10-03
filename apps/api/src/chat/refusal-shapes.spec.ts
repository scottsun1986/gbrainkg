import { isRefusalAnswerText } from './retrieval-arms';
import { isRefusalShapedAnswer } from './citation-assembly';

/**
 * A refusal can be phrased in many ways. The release gate scores "the model
 * answered instead of refusing" from a fixed marker list, and a correct
 * contextual refusal that says "the material does not record …" instead of
 * "未包含相关信息" used to fail that check (P4-01 failed 2 of 5 runs).
 */
describe('isRefusalAnswerText', () => {
  const refusals = [
    '已知知识库资料中未包含相关信息，无法回答该问题。',
    '资料中未记载任何量子纠缠保密通信的技术实施方案编号。',
    '参考资料仅涉及系统设计方案的技术选型，其中出现的唯一编号是运维手册编号 OM-2026-3001，与量子纠缠保密通信无关，资料中未记载任何量子纠缠保密通信的技术实施方案编号。',
    '所提供的资料为《运维手册完整版》的通用填充内容，未出现量子纠缠保密通信相关方案，也无任何技术实施方案编号。',
    '也没有关于量子纠缠保密通信的任何记载。',
    '没有找到相关记录。',
    '未检索到',
    'This is not recorded in the provided reference materials.',
  ];
  it.each(refusals)('recognises as refusal: %s', (text) => {
    expect(isRefusalAnswerText(text)).toBe(true);
  });

  const answers = [
    '员工每年享有带薪年假10天[1]。',
    '运维手册编号为 OM-2026-3001[1]。',
    '考核汇总表的编号是 SUM-2026-5566[1]。',
    '该制度规定了迟到超过30分钟视为旷工半日[2]。',
  ];
  it.each(answers)('does NOT recognise as refusal: %s', (text) => {
    expect(isRefusalAnswerText(text)).toBe(false);
  });

  it('treats empty text as a refusal', () => {
    expect(isRefusalAnswerText('')).toBe(true);
    expect(isRefusalAnswerText('   ')).toBe(true);
  });
});

describe('isRefusalShapedAnswer', () => {
  it('accepts a short contextual refusal', () => {
    expect(isRefusalShapedAnswer('资料中未记载任何技术实施方案编号。', ['资料中未记载任何技术实施方案编号。'])).toBe(true);
  });

  it('rejects a factual answer that merely cites evidence', () => {
    const answer = '运维手册编号为 OM-2026-3001[1]。';
    expect(isRefusalShapedAnswer(answer, [answer])).toBe(false);
  });
});