import {
  extractAnswerFromReasoning,
  isPlanningLikeText,
  isProviderErrorText,
  looksLikeMetaDiscourse,
  looksLikeQuestionEcho,
} from "./output-hygiene";

describe("output hygiene: meta-discourse", () => {
  it("drops narration about the request itself (uncited)", () => {
    expect(
      looksLikeMetaDiscourse('我注意到用户在问题末尾加了"24"，这可能是测试用例编号或其他标记，根据规范要求我不应复显这类信息。'),
    ).toBe(true);
    expect(looksLikeMetaDiscourse('好的，用户询问的是关于"公司2028年的火星殖民计划"的预算问题。')).toBe(true);
    expect(looksLikeMetaDiscourse('The test case adds a trailing number to the question.')).toBe(true);
  });

  it("keeps cited knowledge-base statements that happen to mention the reader", () => {
    expect(looksLikeMetaDiscourse('用户首次登录须完成实名认证，流程见《账号管理办法》第3条[2]。')).toBe(false);
    expect(looksLikeMetaDiscourse('代码审查质量评分计入研发人员能力指标，占绩效总分的10%[1]。')).toBe(false);
  });
});

describe("output hygiene: reasoning recovery", () => {
  // Verbatim strings captured from the live test environment (2026-09-20).
  it("rejects the planning-only trace that reached MuSiQue users", () => {
    const leaked =
      "The answer is straightforward—just need to state the century directly with the " +
      "citation from Source 1. No extra details needed since the question is specific.";
    expect(extractAnswerFromReasoning(leaked)).toBe("");
    expect(isPlanningLikeText(leaked)).toBe(true);
  });

  it("rejects a trace that only narrates what the user asked", () => {
    const leaked =
      "Hmm, the user is asking about the century when the author of *A Treatise " +
      "Concerning the Principles of Human Knowledge* lived. The query is straightforward.";
    expect(extractAnswerFromReasoning(leaked)).toBe("");
  });

  it("keeps the drafted sentence when scratchpad follows it", () => {
    const trace =
      "Based on the provided reference materials, the burial place of Charles Mathew's " +
      "father is not documented.Hmm, the user is asking about the burial place of " +
      "Charles Mathew's father. Let me check the provided sources first.";
    expect(extractAnswerFromReasoning(trace)).toBe(
      "Based on the provided reference materials, the burial place of Charles Mathew's father is not documented.",
    );
  });

  it("keeps a substantive drafted answer with citations", () => {
    const trace =
      "Gustave Courbet was born on 10 June 1819 in Ornans, France [1][2].\n\n" +
      "I should keep the answer concise and only state the birth date.";
    expect(extractAnswerFromReasoning(trace)).toBe(
      "Gustave Courbet was born on 10 June 1819 in Ornans, France [1][2].",
    );
  });

  it("returns an empty string instead of a too-short fragment", () => {
    expect(extractAnswerFromReasoning("Paris.")).toBe("");
    expect(extractAnswerFromReasoning("")).toBe("");
  });

  it("recognises Chinese planning voice", () => {
    expect(extractAnswerFromReasoning("我们需要先确认用户的问题，再检索证据。")).toBe("");
  });

  // Verbatim strings from the enterprise no-answer run (2026-09-21) where a
  // fragment of this narration was displayed as the answer.
  it("recognises the Chinese narration the enterprise run leaked", () => {
    for (const leaked of [
      '用户询问的是"公司2028年的火星殖民计划具体预算是多少"。',
      '好的，用户询问的是关于“公司2028年的火星殖民计划”的预算问题。',
      '我需要严格基于提供的参考知识库资料来回答。',
      '这看起来是一个关于未来计划和预算的具体问题。',
    ]) {
      expect(isPlanningLikeText(leaked)).toBe(true);
      expect(extractAnswerFromReasoning(leaked)).toBe('');
    }
  });

  it("keeps ordinary Chinese answers that merely mention the reader", () => {
    for (const answer of [
      '代码审查质量评分计入研发人员能力指标，占绩效总分的10%[1]。',
      '用户首次登录须完成实名认证，流程见《账号管理办法》第3条[2]。',
      '这是一项规定动作：所有合并到主分支的代码均需通过 Code Review[1]。',
    ]) {
      expect(isPlanningLikeText(answer)).toBe(false);
    }
  });
});

describe("output hygiene: upstream transport failures", () => {
  it("flags the gateway rejection observed in a MuSiQue answer", () => {
    const error = "The request was rejected because it was considered high risk";
    expect(isProviderErrorText(error)).toBe(true);
    expect(extractAnswerFromReasoning(`${error}Okay, let me break down the question.`)).toBe("");
  });

  it("flags rate-limit and quota text", () => {
    expect(isProviderErrorText("Rate limit reached for requests")).toBe(true);
    expect(isProviderErrorText("Insufficient balance, please top up")).toBe(true);
    expect(isProviderErrorText("We need to check the sources")).toBe(false);
  });

  it("does not flag ordinary answers that mention risk or limits", () => {
    expect(
      isProviderErrorText(
        "The policy caps the allowance and flags high-risk cargo; the limit is 25 kg [1].",
      ),
    ).toBe(false);
  });
});

describe("output hygiene: question echo", () => {
  it("flags the echo returned by the answer-only retry", () => {
    const echoed =
      'First, the user asked: "What century did the author of A Treatise Concerning ' +
      "the Principles of Human Knowledge live in?";
    expect(
      looksLikeQuestionEcho(
        echoed,
        "What century did the author of A Treatise Concerning the Principles of Human Knowledge live in?",
      ),
    ).toBe(true);
  });

  it("keeps a real answer that restates a few terms of the question", () => {
    expect(
      looksLikeQuestionEcho(
        "George Berkeley, the author of A Treatise Concerning the Principles of Human Knowledge, lived in the 18th century [1][2].",
        "What century did the author of A Treatise Concerning the Principles of Human Knowledge live in?",
      ),
    ).toBe(false);
  });

  it("flags a Chinese question echoed back without citations", () => {
    expect(
      looksLikeQuestionEcho(
        "用户的问题是：软件研发中心绩效管理办法第1条是什么内容？",
        "软件研发中心绩效管理办法第1条是什么内容？",
      ),
    ).toBe(true);
  });
});
