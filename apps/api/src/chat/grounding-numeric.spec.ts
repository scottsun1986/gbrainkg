import {
  extractNumberUnits,
  numberNearBound,
  numericClaimsSupportedBy,
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
