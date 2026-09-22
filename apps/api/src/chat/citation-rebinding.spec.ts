import { findSupportingEvidenceIndex, rebindCitationMarkers } from './chat.service';

/**
 * Regression for the production defect observed on 2026-09-19: the answer
 * about 王群丽 was correct, the teacher's document was source 7 in the prompt,
 * but the model stamped [1] - a weekly-report PDF - and the UI showed that
 * unrelated document as the citation.
 */
describe('citation marker re-binding', () => {
  const teacherDoc = {
    context:
      '我的宝藏老师\n我有一位宝藏老师，她叫王群丽，正像她的名字一样，既有着王者之气又有着美丽外貌。' +
      '她总穿着一身柔滑的连衣裙，系着一个干练的马尾辫。她从来都是劳逸结合而非一味苦干，' +
      '经常组织一些集体活动，初一入学到现在，她自掏腰包组织的散心活动也有六七次了。',
  };
  const weeklyReport = {
    context:
      '## 五、低空平台\n|地市|全省|苏州|南京|无锡|\n|---|---|---|---|---|\n|签约:万|16088|4172|1842|1746|\n' +
      '本周进展：新增苏州市公安巡特警支队低空安全防控平台卡位（星盾平台）。',
  };
  const annualReport = { context: '2026 年度经营分析：全省签约金额 46508 万元，完成率 38.8%。' };

  it('re-binds a wrong marker to the evidence that actually supports the sentence', () => {
    const pool = [weeklyReport, annualReport, teacherDoc];
    const sentence = '王群丽是一位中学老师，她自掏腰包组织集体活动帮助学生减压[1]。';

    // The marker the model produced is wrong: source 1 is the weekly report.
    expect(findSupportingEvidenceIndex(sentence, [pool[0]])).toBeNull();
    const rebound = rebindCitationMarkers(sentence, pool);

    expect(rebound).not.toBeNull();
    expect(rebound!.index).toBe(3);
    expect(rebound!.sentence).toContain('[3]');
    expect(rebound!.sentence).not.toContain('[1]');
  });

  it('leaves a correct marker untouched', () => {
    const pool = [weeklyReport, teacherDoc];
    const sentence = '王群丽是学生眼中的宝藏老师，她组织采茶集体活动[2]。';
    // Already pointing at the supporting source: no rewrite is reported.
    expect(findSupportingEvidenceIndex(sentence, [teacherDoc])).toBe(1);
    const rebound = rebindCitationMarkers(sentence, [teacherDoc, weeklyReport]);
    expect(rebound!.sentence).toContain('[1]');
  });

  it('returns null when no selected evidence supports the sentence', () => {
    const pool = [weeklyReport, annualReport];
    const sentence = '王群丽是一位中学老师，她自掏腰包组织集体活动帮助学生减压[1]。';
    expect(findSupportingEvidenceIndex(sentence, pool)).toBeNull();
    expect(rebindCitationMarkers(sentence, pool)).toBeNull();
  });

  it('collapses duplicated markers to the single supporting source', () => {
    const pool = [weeklyReport, teacherDoc];
    const sentence = '她叫王群丽，是宝藏老师[1][1]。';
    const rebound = rebindCitationMarkers(sentence, pool, 0.4);
    expect(rebound).not.toBeNull();
    expect(rebound!.sentence.match(/\[\d+\]/g)).toEqual(['[2]']);
  });

  it('does not fabricate support when the sentence contradicts the evidence', () => {
    const pool = [
      { context: '第三十八条 员工报销标准不得高于 800 元，超出部分不予报销。' },
      { context: '第四十条 差旅补贴标准为每日 200 元。' },
    ];
    const sentence = '员工报销标准不得低于 8000 元[1]。';
    expect(rebindCitationMarkers(sentence, pool)).toBeNull();
  });
});
