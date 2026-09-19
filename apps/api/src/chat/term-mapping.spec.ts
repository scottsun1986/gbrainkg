import { parseTermMappings, expandQueryWithTermMappings } from "./term-mapping";

describe("parseTermMappings", () => {
  it("parses the object map form", () => {
    expect(parseTermMappings({ 打车: ["交通费", "交通费用报销"] })).toEqual([
      { from: "打车", to: ["交通费", "交通费用报销"] },
    ]);
  });

  it("parses a list of {from,to} records and accepts a scalar target", () => {
    expect(parseTermMappings([{ from: "年假", to: "带薪年休假" }])).toEqual([
      { from: "年假", to: ["带薪年休假"] },
    ]);
  });

  it("returns nothing for the legacy flat hint-term array", () => {
    expect(parseTermMappings(["报销", "发票"])).toEqual([]);
  });

  it("drops empty and self-referential targets", () => {
    expect(parseTermMappings({ 请假: ["请假", " ", "假期管理"] })).toEqual([
      { from: "请假", to: ["假期管理"] },
    ]);
  });
});

describe("expandQueryWithTermMappings", () => {
  const mappings = parseTermMappings({ 打车: ["交通费", "交通费用报销"] });

  it("appends and substitutes the formal term when the trigger is present", () => {
    const variants = expandQueryWithTermMappings("打车报销标准是什么", mappings);
    expect(variants.some((v) => v.includes("交通费"))).toBe(true);
    // Substitution uses the first target, so "打车报销标准" -> "交通费报销标准".
    expect(variants.some((v) => v.includes("交通费报销标准"))).toBe(true);
  });

  it("does nothing when the trigger is absent", () => {
    expect(expandQueryWithTermMappings("年假天数", mappings)).toEqual([]);
  });

  it("matches case-insensitively for latin triggers", () => {
    const idMappings = parseTermMappings({ api: ["application programming interface"] });
    const variants = expandQueryWithTermMappings("API rate limit", idMappings);
    expect(variants.some((v) => v.includes("application programming interface"))).toBe(true);
  });

  it("caps the number of variants", () => {
    const many = parseTermMappings({ x: ["a"], y: ["b"], z: ["c"] });
    expect(expandQueryWithTermMappings("x y z", many, 2).length).toBeLessThanOrEqual(2);
  });
});
