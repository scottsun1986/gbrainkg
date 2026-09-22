import {
  answerTypeOf,
  extractCapitalisedCandidates,
  matchesAnswerType,
  selectTypedPassageSources,
  normalizeTitleForMatch,
  parseRetryMarkers,
  rewriteRetryMarkers,
  selectRetrySentenceSources,
  planAspectPassageRescue,
  planDocumentCompleteness,
  planSecondHopRescue,
  planTopRankGuarantee,
  selectSupportingSentences,
} from "./bridge-rescue";

// The exact shapes that failed on the live test environment (2026-09-20).
describe("second-hop rescue", () => {
  const bisquickQuestion = "In what state is the manufacturer of Bisquick headquartered?";
  const hopOne = [
    "Bisquick is a pre-mixed baking mix sold by General Mills under its Betty Crocker brand, " +
      "consisting of flour, shortening, salt, and baking powder.",
  ];
  const pool = [
    { title: "Bisquick", score: 0.8, text: hopOne[0] },
    {
      title: "General Mills",
      score: 0.063,
      text: "General Mills, Inc., is an American multinational manufacturer… It is headquartered in Golden Valley, Minnesota.",
    },
    { title: "Hyundai Motor Group", score: 0.06, text: "… Minnesota …" },
  ];

  it("rescues the hop-2 document named by the hop-1 evidence", () => {
    const plan = planSecondHopRescue({ selectedTexts: hopOne, pool, question: bisquickQuestion });
    expect(plan.indices).toEqual([1]);
    expect(plan.names).toEqual(["General Mills"]);
  });

  it("never rescues an entity that is already part of the question (hop-1)", () => {
    const plan = planSecondHopRescue({
      selectedTexts: ["Bisquick is a mix."],
      pool,
      question: "What is Bisquick?",
    });
    expect(plan.indices).toEqual([]);
  });

  it("ignores prose fragments without their own document", () => {
    const plan = planSecondHopRescue({
      selectedTexts: ["The Provided Reference Materials Do Not Contain Information."],
      pool,
      question: "Who invented it?",
    });
    expect(plan.names).not.toContain("Provided Reference Materials");
    expect(plan.indices).toEqual([]);
  });

  it("caps the number of rescued documents", () => {
    const widePool = [
      { title: "First Company", score: 0.1, text: "headquartered in one place" },
      { title: "Second Company", score: 0.09, text: "headquartered in another place" },
      { title: "Third Company", score: 0.08, text: "headquartered in a third place" },
    ];
    const plan = planSecondHopRescue({
      selectedTexts: ["First Company and Second Company and Third Company are all mentioned here."],
      pool: widePool,
      question: "Which one is headquartered where?",
      maxRescue: 2,
    });
    expect(plan.indices).toHaveLength(2);
  });

  it("does nothing when the selected evidence already covers every question aspect", () => {
    const plan = planSecondHopRescue({
      selectedTexts: [
        "Woman's Era is a fortnightly women interest magazine; Naj is a fortnightly women interest magazine.",
      ],
      pool: [
        {
          title: "Woman's Era",
          score: 0.7,
          text: "Woman's Era is a fortnightly women interest magazine published in India.",
        },
      ],
      question: "Woman's Era and Naj are what kind of magazines?",
    });
    expect(plan.indices).toEqual([]);
    expect(plan.missingAspects).toEqual([]);
  });

  it("returns nothing when the pool has no matching document", () => {
    const plan = planSecondHopRescue({
      selectedTexts: hopOne,
      pool: [{ title: "Unrelated Page", score: 0.9, text: "nothing" }],
      question: bisquickQuestion,
    });
    expect(plan.indices).toEqual([]);
    expect(plan.names).toEqual([]);
  });
});

describe("bridge-rescue helpers", () => {
  it("normalises titles across case, extension and punctuation", () => {
    expect(normalizeTitleForMatch("  General_Mills.PDF ")).toBe("generalmills");
    expect(normalizeTitleForMatch("《2026年度培训计划》(V2)")).toContain("2026年度培训计划");
  });

  it("extracts multi-word capitalised entities only", () => {
    const names = extractCapitalisedCandidates(
      "The Rome Protocols were signed; Sadok Sassi played for the Tunisian national team.",
    );
    expect(names).toContain("Rome Protocols");
    expect(names).toContain("Sadok Sassi");
    expect(names).not.toContain("The");
  });
});

describe("document completeness (page in context, passage missing)", () => {
  const key = (c: any) => String(c?.docId || c?.title || "");

  it("adds the next-best chunk of a leading selected document", () => {
    const selected = [{ docId: "d1", title: "Lana Wood", evidence: "page intro" }];
    const pool = [
      { docId: "d1", title: "Lana Wood", score: 0.1, evidence: "page intro" },
      { docId: "d1", title: "Lana Wood", score: 0.09, evidence: "She is the sister of Natalie Wood." },
      { docId: "d2", title: "Unrelated", score: 0.9, evidence: "not selected" },
    ];
    const plan = planDocumentCompleteness({ selected, pool, keyOf: key });
    expect(plan.indices).toEqual([1]);
    expect(plan.docs).toHaveLength(1);
  });

  it("never introduces a document that was not selected", () => {
    const selected = [{ docId: "d1", title: "A", evidence: "a" }];
    const pool = [
      { docId: "d2", title: "B", score: 0.9, evidence: "b" },
      { docId: "d3", title: "C", score: 0.8, evidence: "c" },
    ];
    expect(planDocumentCompleteness({ selected, pool, keyOf: key }).indices).toEqual([]);
  });

  it("respects the per-document cap and skips already-selected chunks", () => {
    const selected = [{ docId: "d1", title: "A", evidence: "a" }];
    const pool = [
      { docId: "d1", title: "A", score: 0.5, evidence: "a" },
      { docId: "d1", title: "A", score: 0.4, evidence: "b" },
      { docId: "d1", title: "A", score: 0.3, evidence: "c" },
    ];
    const plan = planDocumentCompleteness({ selected, pool, keyOf: key, maxPerDoc: 1 });
    expect(plan.indices).toEqual([1]);
  });
});

describe("aspect-targeted passage rescue", () => {
  const key = (c: any) => String(c?.docId || c?.title || "");

  it("picks the passage covering the missing question aspect, not the next-best score", () => {
    const selected = [
      {
        docId: "mara",
        title: "Mara Wilson",
        evidence: "Mara Wilson played Susan Walker in Miracle on 34th Street.",
      },
    ];
    const pool = [
      { docId: "mara", title: "Mara Wilson", score: 0.9, evidence: "Mara Wilson played Susan Walker." },
      // Higher score but the wrong passage: talks about her career, not siblings.
      { docId: "mara", title: "Mara Wilson", score: 0.5, evidence: "She later worked as a writer." },
      // Lower score, but it holds the fact the question needs.
      {
        docId: "mara",
        title: "Mara Wilson",
        score: 0.2,
        evidence: "Her younger sister is the actress Lana Wood.",
      },
    ];
    const plan = planAspectPassageRescue({
      selected,
      pool,
      question: "Who is the sibling of the actress who played Susan Walker?",
      keyOf: key,
    });
    expect(plan.indices).toEqual([2]);
    expect(plan.aspects).toContain("sibling");
  });

  it("stays out of the way when the context already covers every aspect", () => {
    const plan = planAspectPassageRescue({
      selected: [{ docId: "d1", title: "A", evidence: "The sibling is Lana Wood." }],
      pool: [{ docId: "d1", title: "A", score: 0.1, evidence: "other" }],
      question: "Who is the sibling?",
      keyOf: key,
    });
    expect(plan.indices).toEqual([]);
  });

  it("never pulls a passage from a document that was not selected", () => {
    const plan = planAspectPassageRescue({
      selected: [{ docId: "d1", title: "A", evidence: "nothing useful here" }],
      pool: [{ docId: "d2", title: "B", score: 0.9, evidence: "holds the sibling fact" }],
      question: "Who is the sibling?",
      keyOf: key,
    });
    expect(plan.indices).toEqual([]);
  });
});

describe("supporting sentences for a refusal re-check", () => {
  it("finds the sentence that covers the question's own terms", () => {
    const evidence = [
      "Bisquick is a pre-mixed baking mix sold by General Mills under its Betty Crocker brand.",
      "General Mills is an American multinational manufacturer headquartered in Golden Valley, Minnesota.",
    ];
    const picked = selectSupportingSentences(
      evidence,
      "In what state is the manufacturer of Bisquick headquartered?",
      { limit: 2, minTerms: 2 },
    );
    // Only the sentence that covers *two* question terms qualifies; the hop-1
    // sentence ("Bisquick is a pre-mixed baking mix…") covers just one.
    expect(picked).toHaveLength(1);
    expect(picked[0]).toContain("headquartered");
  });

  it("returns nothing when the evidence does not touch the question", () => {
    expect(
      selectSupportingSentences(
        ["The treaty was signed in 1920 by three prime ministers."],
        "What is the melting point of gallium?",
        { minTerms: 2 },
      ),
    ).toEqual([]);
  });

  it("works for Chinese evidence and questions", () => {
    const picked = selectSupportingSentences(
      ["代码审查质量评分计入研发人员能力指标，占绩效总分的10%。"],
      "代码审查质量如何影响绩效？",
      { minTerms: 2 },
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]).toContain("代码审查");
  });
});

describe("top-rank document guarantee", () => {
  const key = (c: any) => String(c?.docId || c?.title || "");

  // The exact pool shape of the failing case: three chunks of the hop-1 page,
  // then the page that actually holds the answer.
  const pool = [
    { docId: "mathew", title: "Charles Mathew", score: 0.80, evidence: "a" },
    { docId: "mathew", title: "Charles Mathew", score: 0.78, evidence: "b" },
    { docId: "mathew", title: "Charles Mathew", score: 0.59, evidence: "c" },
    { docId: "james", title: "James Charles Mathew", score: 0.063, evidence: "buried in Cork" },
    { docId: "adolf", title: "Adolf, Duke of Jülich-Berg", score: 0.05, evidence: "d" },
  ];

  it("restores a leading document that the score floor pruned", () => {
    const selected = [pool[0], pool[1], pool[2]];
    const plan = planTopRankGuarantee({ selected, pool, keyOf: key, topDocs: 5 });
    // Score order: mathew .80, mathew .78, mathew .59, james .063, adolf .05.
    // "mathew" is already represented, so the two leading *missing* documents
    // are james (.063) then adolf (.05).
    expect(plan.indices).toEqual([3, 4]);
  });

  it("orders by score, not by the pool's (probe-polluted) position", () => {
    // Real pool shape from the Rome-Protocols failure: probe candidates with
    // near-zero scores sit above the document that holds the answer.
    const pollutedPool = [
      { docId: "rome", title: "Rome Protocols", score: 0.896, evidence: "a" },
      { docId: "avner", title: "Yehuda Avner", score: 0.001, evidence: "b" },
      { docId: "gray", title: "Herb Gray", score: 0.013, evidence: "c" },
      { docId: "seaford", title: "Seaford", score: 0.002, evidence: "d" },
      { docId: "dollfuss", title: "Engelbert Dollfuss", score: 0.165, evidence: "failed coup" },
    ];
    const plan = planTopRankGuarantee({
      selected: [pollutedPool[0]],
      pool: pollutedPool,
      keyOf: key,
      topDocs: 2,
    });
    // The union ordering may also carry probe-position documents, but the
    // answering page must be among the restored ones.
    expect(plan.docs).toContain("dollfuss");
    expect(plan.indices).toContain(4);
  });

  it("adds nothing when the leading documents are already represented", () => {
    const selected = [pool[0], pool[3]];
    const plan = planTopRankGuarantee({ selected, pool, keyOf: key, topDocs: 2 });
    expect(plan.indices).toEqual([]);
  });

  it("never adds a second passage of an already-represented document", () => {
    const selected = [pool[0]];
    const plan = planTopRankGuarantee({ selected, pool, keyOf: key, topDocs: 1 });
    expect(plan.indices).toEqual([]);
  });
});

describe("refusal re-check over the wider pool", () => {
  const question = "Sadok Sassi played for a national team that made its first World Cup in what year?";
  const contextSource = {
    text: "Sadok Sassi played for the Tunisian national team.",
    citation: { docTitle: "Sadok Sassi" },
  };
  const poolSource = {
    text: "Tunisia national football team first qualified for the World Cup in 1978.",
    citation: { docTitle: "Tunisia national football team" },
  };

  it("offers sentences from pool documents that never entered the context", () => {
    const picked = selectRetrySentenceSources([contextSource, poolSource], question, { minTerms: 2 });
    expect(picked.map((p) => p.citation.docTitle)).toContain("Tunisia national football team");
  });

  it("keeps the citation attached to every offered sentence", () => {
    const picked = selectRetrySentenceSources([poolSource], question, { minTerms: 2 });
    expect(picked).toHaveLength(1);
    expect(picked[0].citation.docTitle).toBe("Tunisia national football team");
  });
});

describe("retry marker provenance", () => {
  it("parses 【资料N】 and bare 资料N markers", () => {
    expect(parseRetryMarkers("答案见【资料2】，另见资料1。")).toEqual([1, 2]);
    expect(parseRetryMarkers("没有标记")).toEqual([]);
  });

  it("rewrites markers into citation indices", () => {
    const mapping = new Map([[1, 3], [2, 4]]);
    expect(rewriteRetryMarkers("答案是 1978【资料2】，来自资料1。", mapping)).toBe(
      "答案是 1978[4]，来自[3]。",
    );
  });

  it("leaves unknown markers untouched so nothing silently loses its source", () => {
    expect(rewriteRetryMarkers("见【资料9】", new Map([[1, 1]]))).toBe("见【资料9】");
  });
});

describe("typed passage selection", () => {
  it("classifies the asked answer type", () => {
    expect(answerTypeOf("Sadok Sassi played for a national team that made its first World Cup in what year?")).toBe("year");
    expect(answerTypeOf("When did the mosque open?")).toBe("date");
    expect(answerTypeOf("Where was the director born?")).toBe("place");
    expect(answerTypeOf("Who is the paternal grandfather?")).toBe("person");
  });

  it("recognises sentences that carry the asked fact type", () => {
    expect(matchesAnswerType("They first qualified in 1978.", "year")).toBe(true);
    expect(matchesAnswerType("They first qualified for the tournament.", "year")).toBe(false);
    expect(matchesAnswerType("It opened in September 2012.", "date")).toBe(true);
    // Places and people are not regex-typed; the selector must not pretend otherwise.
    expect(matchesAnswerType("anything", "place")).toBe(true);
  });

  it("prefers the sentence carrying the asked fact over a same-topic distractor", () => {
    const sources = [
      {
        citation: { docTitle: "Olle Nordin" },
        text: "He was capped 19 times for the national team and played at the 1978 FIFA World Cup.",
      },
      {
        citation: { docTitle: "Tunisia national football team" },
        text: "They have qualified for four FIFA World Cups, the first one in 1978.",
      },
    ];
    const picked = selectTypedPassageSources(
      sources,
      "Sadok Sassi played for a national team that made its first World Cup in what year?",
      { linkText: "Sadok Sassi played for the Tunisian national team.", minTerms: 2, limit: 1 },
    );
    expect(picked[0]?.citation?.docTitle).toBe("Tunisia national football team");
  });

  it("drops documents that are not linked to the question or the hop-1 evidence", () => {
    const sources = [
      { citation: { docTitle: "Olle Nordin" }, text: "He played at the 1978 FIFA World Cup for the national team." },
    ];
    const picked = selectTypedPassageSources(
      sources,
      "Sadok Sassi played for a national team that made its first World Cup in what year?",
      { linkText: "Sadok Sassi played for the Tunisian national team.", minTerms: 2 },
    );
    expect(picked).toEqual([]);
  });
});

describe("top-rank guarantee: score order or pool order alone is not enough", () => {
  const key = (c: any) => String(c?.docId || c?.title || "");

  it("restores a bridge page that is 6th by score but 3rd in the pool", () => {
    // Real pool shape (HotpotQA "Sadok Sassi … first World Cup"): the hop-1 page
    // dominates the score distribution, so the answering page loses on score rank.
    const pool = [
      { docId: "sassi", title: "Sadok Sassi", score: 0.898, evidence: "a" },
      { docId: "nordin", title: "Olle Nordin", score: 0.005, evidence: "b" },
      { docId: "tunisia", title: "Tunisia national football team", score: 0.027, evidence: "c" },
      { docId: "kenya", title: "Kenya at the Cricket World Cup", score: 0.045, evidence: "d" },
      { docId: "wc2002", title: "2002 FIFA World Cup", score: 0.098, evidence: "e" },
      { docId: "wc98", title: "World Cup 98 (video game)", score: 0.007, evidence: "f" },
    ];
    const plan = planTopRankGuarantee({
      selected: [{ docId: "sassi", title: "Sadok Sassi" }],
      pool,
      keyOf: key,
      topDocs: 5,
    });
    expect(plan.docs).toContain("tunisia");
  });

  it("still restores a page that is 2nd by score but 7th in the pool", () => {
    const pool = [
      { docId: "rome", title: "Rome Protocols", score: 0.896, evidence: "a" },
      { docId: "noise1", title: "N1", score: 0.001, evidence: "b" },
      { docId: "noise2", title: "N2", score: 0.002, evidence: "c" },
      { docId: "noise3", title: "N3", score: 0.003, evidence: "d" },
      { docId: "noise4", title: "N4", score: 0.004, evidence: "e" },
      { docId: "noise5", title: "N5", score: 0.005, evidence: "f" },
      { docId: "dollfuss", title: "Engelbert Dollfuss", score: 0.165, evidence: "failed coup" },
    ];
    const plan = planTopRankGuarantee({
      selected: [{ docId: "rome", title: "Rome Protocols" }],
      pool,
      keyOf: key,
      topDocs: 5,
    });
    expect(plan.docs).toContain("dollfuss");
  });
});

describe("capitalised candidate extraction with non-ASCII names", () => {
  it("keeps the full name instead of truncating at the accented letter", () => {
    const names = extractCapitalisedCandidates(
      "The Autobiography of Nicolae Ceaușescu is a 2010 Romanian documentary film directed by Andrei Ujică.",
    );
    expect(names).toContain("Andrei Ujică");
    expect(names.some((n) => n.includes("Ceaușescu"))).toBe(true);
    expect(names).not.toContain("Andrei Ujic");
  });

  it("still stops at sentence boundaries", () => {
    const names = extractCapitalisedCandidates("Directed by Douglas Sirk. It was released in 1959.");
    expect(names).toContain("Douglas Sirk");
  });

  it("handles the Dutch/French particles in titles", () => {
    expect(extractCapitalisedCandidates("Magnus Julius De la Gardie was a Swedish general.")).toContain(
      "Magnus Julius De la Gardie",
    );
  });
});
