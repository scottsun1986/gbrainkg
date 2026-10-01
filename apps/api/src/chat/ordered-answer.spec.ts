import { OrderedAnswer } from './ordered-answer';

describe('verified answer order', () => {
  it('restores delayed evidence beneath its own heading, ahead of later sections', () => {
    const answer = new OrderedAnswer();
    answer.append(0, '**当前版本**\n');
    answer.append(1, '当前条款[1]。\n');
    answer.append(2, '**历史版本**\n');
    answer.append(4, '**版本差异**\n');
    answer.append(5, '比较结论[1][2]。');
    answer.append(3, '历史条款[2]。\n');
    expect(answer.render()).toBe('**当前版本**\n当前条款[1]。\n**历史版本**\n历史条款[2]。\n**版本差异**\n比较结论[1][2]。');
  });
  it('drops rejected slots without moving approved table rows or duplicating fragments', () => {
    const answer = new OrderedAnswer();
    answer.append(0, '| 字段 | 数值 |\n|---|---|\n');
    answer.append(3, '\n结论。');
    answer.append(1, '| 已核验 | 30[1] |\n');
    expect(answer.render()).toBe('| 字段 | 数值 |\n|---|---|\n| 已核验 | 30[1] |\n\n结论。');
    expect(answer.render()).toBe(answer.render());
  });
});
