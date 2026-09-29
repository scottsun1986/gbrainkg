import {
  extractNumberUnits,
  numberNearBound,
  numericClaimsSupportedBy,
  decisiveValueSupportedBy,
} from "./grounding-numeric";

describe("extractNumberUnits", () => {
  it("captures value and unit pairs", () => {
    expect(extractNumberUnits("响应时间 0.8s，延迟 800 毫秒")).toEqual([
      { raw: "0.8", value: 0.8, unit: "s" },
      { raw: "800", value: 800, unit: "毫秒" },
    ]);
  });
});

describe("numberNearBound", () => {
  it("finds the number next to a bound expression", () => {
    expect(numberNearBound("不得低于800毫秒", /不得低于|不低于/)).toBe(800);
    expect(numberNearBound("上限为 10 万元", /上限/)).toBe(10);
  });

  it("returns null when no number is nearby", () => {
    expect(numberNearBound("不得低于标准值", /不得低于/)).toBeNull();
  });
});

describe("numericClaimsSupportedBy", () => {
  it("accepts a literal numeric claim", () => {
    expect(numericClaimsSupportedBy("超时为 800 毫秒", "系统超时为 800 毫秒")).toBe(true);
  });

  it("accepts a correct unit conversion", () => {
    expect(numericClaimsSupportedBy("超时为 800 毫秒", "系统超时为 0.8s")).toBe(true);
    expect(numericClaimsSupportedBy("最长等待 2 小时", "最长等待 120 分钟")).toBe(true);
  });

  it("rejects a fabricated or mistranslated number", () => {
    expect(numericClaimsSupportedBy("超时为 500 毫秒", "系统超时为 800 毫秒")).toBe(false);
    expect(numericClaimsSupportedBy("最长等待 3 小时", "最长等待 120 分钟")).toBe(false);
  });

  it("rejects a unitless fabricated number", () => {
    expect(numericClaimsSupportedBy("共 42 项", "共 7 项")).toBe(false);
  });
});

describe("decisiveValueSupportedBy", () => {
  const noise = [
    "The 2022 Winter Paralympics were held in Beijing. The torch relay visited 9 cities.",
    "Beijing hosted about 500 athletes across 6 sports.",
  ];

  it("rejects a parametric-memory date absent from the evidence", () => {
    expect(
      decisiveValueSupportedBy(
        "The 2022 Winter Paralympic Games started on March 4, 2022. [1]",
        noise,
        "When do the Paralympic Winter Games 2022 start?",
      ),
    ).toBe(false);
  });

  it("accepts the same sentence once the date is in the evidence", () => {
    const withDate = [...noise, "The Games started on March 4, 2022 in Beijing."];
    expect(
      decisiveValueSupportedBy(
        "The 2022 Winter Paralympic Games started on March 4, 2022. [1]",
        withDate,
        "When do the Paralympic Winter Games 2022 start?",
      ),
    ).toBe(true);
  });

  it("tolerates day-first date order in the evidence", () => {
    const withDate = ["The opening ceremony took place on 4 March 2022."];
    expect(
      decisiveValueSupportedBy("The Games opened on March 4, 2022. [2]", withDate, "When did the Games open?"),
    ).toBe(true);
  });

  it("rejects an invented proper noun on a short factoid sentence", () => {
    expect(
      decisiveValueSupportedBy(
        "The fairy godmother was voiced by Jennifer Aniston. [1]",
        ["The fairy godmother was voiced by Jennifer Saunders."],
        "Who voiced the fairy godmother in Shrek 2?",
      ),
    ).toBe(false);
  });

  it("accepts a synthesis whose entities all appear in the evidence", () => {
    expect(
      decisiveValueSupportedBy(
        "Both Jerome Bernard and Ira Lewis acted in Chinese Coffee. [1][4]",
        ["Jerome Bernard appeared in Chinese Coffee.", "Ira Lewis had a role in Chinese Coffee."],
        "What film adaptation do Jerome Bernard and Ira Lewis have in common?",
      ),
    ).toBe(true);
  });

  it("checks Chinese month-day combos", () => {
    expect(decisiveValueSupportedBy("生效日期为3月15日。[1]", ["规定自3月15日起施行。"], "什么时候生效?")).toBe(true);
    expect(decisiveValueSupportedBy("生效日期为3月15日。[1]", ["规定自2024年起施行。"], "什么时候生效?")).toBe(false);
  });

  it("still checks dates in long narration but relaxes the proper-noun bar", () => {
    const long = `${"The committee reviewed the proposal in detail and considered several alternatives before reaching its conclusion about the annual budget. "}The date was March 4, 2022.`;
    // Dates stay decisive at any length: a fabricated month-day is never
    // releasable by overlap alone.
    expect(decisiveValueSupportedBy(long, noise, "What did the committee do?")).toBe(false);
    const withDate = [...noise, "The decision was recorded on March 4, 2022."];
    expect(decisiveValueSupportedBy(long, withDate, "What did the committee do?")).toBe(true);
  });
});

describe("decisiveValueSupportedBy ISO-date evidence", () => {
  it("accepts a month-name answer against an ISO date source", () => {
    expect(
      decisiveValueSupportedBy(
        "Daniel Day-Lewis was born on April 29, 1957. [1]",
        ["Daniel Day-Lewis actor. date of birth: 1957-04-29. country of citizenship: UK."],
        "When was Daniel Day Lewis born?",
      ),
    ).toBe(true);
  });

  it("still rejects an invented day against an ISO date source", () => {
    expect(
      decisiveValueSupportedBy(
        "Daniel Day-Lewis was born on April 30, 1957. [1]",
        ["Daniel Day-Lewis actor. date of birth: 1957-04-29."],
        "When was Daniel Day Lewis born?",
      ),
    ).toBe(false);
  });
});
