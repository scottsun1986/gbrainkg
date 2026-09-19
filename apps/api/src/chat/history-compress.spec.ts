import { compressConversationHistory, extractiveDigest } from "./history-compress";

describe("extractiveDigest", () => {
  it("strips citations and markdown and collapses whitespace", () => {
    expect(extractiveDigest("# 标题\n\n内容 [1] 如下。", 100)).toBe("标题 内容 如下。");
  });

  it("cuts at a sentence boundary within the limit", () => {
    const text = "第一句完整内容。第二句也应该被保留。第三句超出限制不应出现。";
    const digest = extractiveDigest(text, 18);
    expect(digest.endsWith("…")).toBe(true);
    expect(digest).not.toContain("第三句");
  });
});

describe("compressConversationHistory", () => {
  it("keeps recent turns verbatim and compresses older ones", () => {
    const history = [
      { role: "user" as const, content: "第一个问题：年假多少天？" },
      { role: "assistant" as const, content: "年假为 5 天。" },
      { role: "user" as const, content: "最近问题一" },
      { role: "assistant" as const, content: "回答一" },
    ];
    const compressed = compressConversationHistory(history, { recentMessages: 2 });
    expect(compressed).toHaveLength(4);
    expect(compressed[2].content).toBe("最近问题一");
    expect(compressed[3].content).toBe("回答一");
    expect(compressed[0].content).toContain("年假");
  });

  it("drops the oldest digests first when over budget", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `第${i}轮消息内容重复填充填充填充填充填充填充填充填充`,
    }));
    const compressed = compressConversationHistory(history, {
      recentMessages: 2,
      olderSnippetChars: 30,
      maxTotalChars: 80,
    });
    // Recent two are always preserved.
    expect(compressed.slice(-2).map((m) => m.content)).toEqual([
      history[8].content,
      history[9].content,
    ]);
    expect(compressed.length).toBeLessThan(history.length);
  });

  it("returns a copy untouched when the history is short", () => {
    const history = [{ role: "user" as const, content: "hi" }];
    const out = compressConversationHistory(history);
    expect(out).toEqual(history);
    expect(out).not.toBe(history);
  });
});
