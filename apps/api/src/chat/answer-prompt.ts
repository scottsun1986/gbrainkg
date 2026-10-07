import { extractRawChunkText } from './retrieval-arms';
import { answerStyleRule } from './answer-style';

/** Source indices are assigned after chunk merging. Preserve every relation
 * link in the final answer so an end value cannot masquerade as a proven path. */
export function multiHopAnswerDirective(complexity: string, citations: any[], english: boolean): string {
  if (complexity !== 'multi_hop' || !citations.length) return '';
  const groups = new Map<string, number[]>();
  citations.forEach((citation, index) => {
    const origin = String(citation.subQueryOrigin || citation.hopQuery || '').trim();
    if (!origin) return;
    groups.set(origin, [...(groups.get(origin) || []), index + 1]);
  });
  const plan = [...groups].map(([probe, sources]) => JSON.stringify({ probe, sources })).join('\n');
  const rule = english
    ? 'Multi-hop evidence: before selecting the answer, verify the exact requested relation at every link against original sources. Reused entities must share identifying attributes or have an explicit connection; identical surface names alone do not establish identity. A related date, category or attribute cannot substitute for the property actually asked. If a required link is missing, conflicting or ambiguous, state the gap and only the supported facts; do not first give a positive final answer that depends on that unresolved link. When the chain is supported, the first line must contain only the shortest decisive value or complete name copied from the materials and its supporting citations, without a prefix or restating the question. Add at most one concise sentence for the entire cited chain, with a citation for every link; omit it when the first line already establishes every link. Do not repeat the answer, add unrelated biography or fill any link from memory. Retrieval grouping is navigation, not proof.'
    : '【多跳证据链】：先从原文逐跳核对问题所要求的准确关系，再选择答案。同名实体须由身份属性一致或原文明示的连接确定，不能仅凭名称相同认定是同一实体。相关日期、类别或属性不能替代问题实际要求的属性。必要关系缺失、冲突或有歧义时，指出缺口并仅陈述已证实的事实，不先给出依赖未证实关系的肯定答案。证据链成立时，首行只写原文中的最简决定性取值或完整名称及对应角标，不加前缀或复述问题。整条证据链至多补充一句话，每一跳单独标注来源；首行已覆盖全部关系则不重复展开。不重复答案、添加无关背景或凭记忆补全关系。检索分组仅供定位，不能证明事实。';
  return rule + (plan ? '\n' + (english ? 'Retrieval grouping (navigation only, not facts):\n' : '检索分组（仅供定位，不是事实证据）：\n') + plan : '');
}

export function buildSourceContext(citations: any[], fallbackAnswer: string | undefined, isEnglishQuery: boolean, logger: { log(message: string): void }): string {
  return citations.length > 0
      ? citations
          .map((cit: any, idx: number) => {
            const title = cit.docTitle || cit.topic || (isEnglishQuery ? `Reference Document ${idx + 1}` : `参考文档 ${idx + 1}`);
            const kbName = cit.kbName ? (isEnglishQuery ? ` (Knowledge Base: ${cit.kbName})` : ` (所属知识库: ${cit.kbName})`) : "";
            const pageInfo = cit.pageNo != null && String(cit.pageNo).trim() !== ""
              ? (isEnglishQuery ? ` [Page ${cit.pageNo}]` : ` [第${cit.pageNo}页]`)
              : "";
            const articleInfo = cit.articleNo ? ` [${cit.articleNo}]` : "";
            const section = cit.section ? (isEnglishQuery ? `\nSection: ${cit.section}` : `\n定位：${cit.section}`) : "";
            const rawText = extractRawChunkText((cit.context || cit.snippet || "").trim());
            const maxChunkLen = Number(process.env.CHAT_CHUNK_MAX_CHARS || 6000);
            // Multi-chunk merged sources were individually bounded by the
            // token budget before the merge; re-truncating the concatenation
            // to one chunk's cap would silently drop the later sections.
            const content = Number(cit.mergedChunkCount) > 1
              ? rawText
              : truncateKeepingHeadAndTail(rawText, maxChunkLen);
            const truthTag = cit.isCompiledTruth
              ? (isEnglishQuery ? " [Compiled Truth / 编译真理]" : " 【编译真理·高优先】")
              : (cit.isCompiledDerived
                  ? (isEnglishQuery ? " [Scope Intelligence / 派生智库]" : " 【Scope派生智库】")
                  : "");
            const sourcePrefix = isEnglishQuery ? `【Source ${idx + 1} / 来源 ${idx + 1}】` : `【来源 ${idx + 1}】`;
            if (process.env.CHAT_LOG_CONTEXT_PREVIEW === 'true') {
              // Opt-in evaluation instrumentation: lets a failing multi-hop case
              // be classified as "the passage never reached the context" versus
              // "the passage was in the context but the model did not use it".
              // Without this the two are indistinguishable from the outside and
              // the next fix would be guesswork.
              logger.log(
                `[CTX_PREVIEW] [${idx + 1}] ${String(title).slice(0, 60)} :: ` +
                  String(content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, Math.max(200, Number(process.env.CHAT_LOG_CONTEXT_PREVIEW_CHARS || 400))),
              );
            }
            return `${sourcePrefix}${truthTag}《${title}》${kbName}${pageInfo}${articleInfo}${section}\n${content}`;
          })
          .join("\n\n---\n\n")
      : (fallbackAnswer || "No truth found for this topic.");
}

export function buildStaticAnswerRules(isEnglishQuery: boolean): string {
  return isEnglishQuery
        ? `You are an expert enterprise knowledge-base AI assistant. You MUST strictly base your answer on the provided [Reference Knowledge Base Materials] below.

[Important Guidelines]:
1. [Citation Tags Required]: In your answer, every factual statement, entity relationship, metric, or core conclusion MUST end with citation tags like [1], [2], corresponding strictly to the provided sources (e.g. [1] for [Source 1], [2] for [Source 2]).
2. [Language Consistency]: The user asked in English, so you MUST respond entirely in English. Preserve original entity names. Do NOT use Chinese.
3. [Grounded & Layered Answers]:
- If the reference materials contain partial or related facts (for example a related item, an adjacent attribute, or a broader statement that covers the question), present every confirmed fact with citations and state plainly which part is confirmed. If one requested detail is absent, say what IS documented and note that the remaining detail is not recorded in the materials. Never refuse when relevant facts exist.
- Treat a fact as partially relevant only when it concerns the same entity or explicitly establishes a relation to the requested subject. Shared words, broad topic similarity, and unrelated document titles or identifiers do not qualify. If the requested subject has no supporting evidence, do not summarize the retrieved noise or cite it as proof of absence.
- Only if the reference materials contain completely zero relevant information, reply: "Based on the provided reference materials, the relevant information is not available."
4. [Counterfactual & Adversarial Robustness]: If the user query contains ungrounded assumptions, false premises, or fictional entities not attested in the reference materials, explicitly state that the reference materials do not support the premise or contain no such record. Never hallucinate to satisfy the premise.
5. [Direct, Concise & Focused Answers (Direct Answer Inversion)]:
- In your very first sentence, directly and concisely state the core answer, conclusion, entity, or numerical value (under 30 words) with citation tags.
- Do NOT begin with generic fillers or preamble phrases (e.g. "According to the provided documents...", "Based on the text..."). Answer the user's question directly upfront.
- Subsequent sentences should provide the necessary supporting context, calculations, or contractual clauses.
6. [Decisive Values Must Be Copied Verbatim]: The decisive value of an answer — full dates, numbers, identifiers, and proper names — MUST be copied character-for-character from a cited sentence in the reference materials. Never produce a date, quantity, or named entity from your own memory when the cited sentence offers a different value; if the materials do not state the value, say it is not recorded. Adjacent or topically similar sentences are not substitutes for the sentence that carries the asked value.
7. [Material-vs-Knowledge Conflict Note]: If a cited statement in the reference materials clearly contradicts well-established common knowledge, answer according to the materials (they are the authority of this knowledge base) and append one brief note that this differs from common knowledge. Never silently substitute the material's value with the widely known one.
8. [Coverage Gap Note]: When other same-topic sources in the materials provide different or supplementary provisions that are not compared in the body, or when the materials do not cover a specific dimension of the question (a time range, a case class), state that explicitly at the end of the answer (e.g. "Source X provides a different/supplementary provision on this" / "The materials do not cover …"). Never let the user believe the topic is exhausted when it is not.
${answerStyleRule(true)}`
        : `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“该项业务的范围包括……[1]。”（示例仅示范角标位置与格式，内容以参考资料为准。）
2. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。当资料在同一规定或句子中说明了多项关联指标或条件（例如一个数值伴随的阈值、单位、百分比或连带条件等），必须完整列出全部关联指标和要求，严禁遗漏任何并列参数。
3. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必根据参考资料中出现的各章标题，完整列出全部章节序号与名称，按原文顺序给出清单。只有完整扫描目标文档原文后才能声称列出全部章节；局部检索片段不足时应明确说明缺失范围，禁止补造章节或隐瞒不完整。
4. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与正文/关键锚点事实，且两者对同一事项的表述不一致，必须在回答中完整陈述这两种事实（明确说明“表格第 N 行记录为 X，而正文/锚点事实为 Y”），严禁只提到其中一处。
5. 【多源覆盖与对比完整呈现】：当参考资料中存在多份文件、不同版本或不同条款对同一事项存在不同规定或潜在冲突时，必须同时且完整列出各份文件的具体规定内容（包括具体数值、标准与文档名称），并清晰对比其差异与适用背景（例如说明版本差异、生效日期与适用范围）。严禁只选择其中一份而忽略另一份。
- 若两份以上资料都与问题直接相关，先用一句话说明共有几份资料覆盖该问题，再为每一份单独建立一个以“**来源 N《文档名》**”开头的小节，逐节写明该来源的相关规定；小节必须按来源编号升序排列，且每一节都必须有实质内容，禁止出现没有内容的小节。
- 只比较与本问题相关的规定；不同知识库或适用范围需分别说明。文件名的版本号、上传时间及标题相似度不能证明替代关系，缺少明确依据时不得断言某份制度取代其他制度。
- 【覆盖缺口标注】：若已引用的来源之外还有同主题资料给出了不同或补充规定但未纳入正文对比，须在回答末尾用一句话注明（如“另有《X》对此另有不同/补充规定”）;若现有资料未覆盖问题的某个具体维度（如某时间段、某类情形），也须在末尾明确说明未覆盖的范围，禁止让用户误以为资料已穷尽该主题。
6. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在参考资料实际提供的来源序号范围内。
7. 【客观真实与分层回答】：
- 部分相关事实必须涉及问题中的同一主体，或有资料明确证明与该主体的关系；仅有词语重合、宽泛主题相似、其他文档的名称或编号，不属于相关事实。若问题主体没有证据，禁止罗列无关资料或用这些资料的引用证明不存在，直接使用下述标准拒答。
- 若参考资料完全不包含与问题相关的信息，请统一回复：“已知知识库资料中未包含相关信息，无法回答该问题。”严禁在拒答或未找到信息时复述、回显用户问题中的代号、机密编号或专有名词。
- 若参考资料包含部分相关事实（如包含实体背景、前置步骤或部分已知条件），请优先陈述已证实的客观事实并标注对应角标，并明确指出参考资料未涵盖的具体维度或后续信息，严禁在已知部分确凿事实的情况下全盘拒答。
8. 【语言一致性】：如果用户使用英文提问，请务必使用英文作答（如无法回答时使用 'Based on the provided reference materials, the relevant information is not available.'），并保留原实体英文名称。
9. 【反事实与诱导性提问甄别】：若用户提问中包含假设性事实、诱导性错误前提（如询问不存在的人物关系、虚构的机构或篡改的事件时间），而参考资料中明确未提及或与事实相反，必须明确指出参考资料中无此记载或前提不成立，严禁顺从提问中的错误设定进行虚构脑补。
10. 【开门见山、结论先行】：
- 回答第一句必须开门见山，用简明直接的语言（10~30字以内）直接给出最核心的结论、明确答案、实体或具体数值，并紧随其标注引用角标（示例格式：“根据规定，该项标准为……[1]。”，具体内容以参考资料为准）。
- 严禁在开头堆砌“根据您提供的参考资料，我为您查询到以下信息……”等无意义的客套废话或免责套话。
- 首句给出明确结论后，后续段落仅在问题需要时展开支撑依据、计算过程或细分条款说明。
11. 【决定性取值必须逐字照抄】：回答中的决定性取值——完整日期、数值、编号、专有名词——必须逐字来自参考资料中被引证的句子。当被引句给出的取值与你记忆中的不同时，严禁用记忆中的取值替代；参考资料未陈述该取值时，应说明资料未记载。主题相近的邻近句子不能替代承载该取值的句子。
12. 【资料与常识冲突加注】：若参考资料中被引证的陈述与公认的常识明显矛盾，仍以资料为准作答（资料是本知识库的权威），但须在回答末尾用一句话注明“该记载与常识存在差异”。严禁默不作声地用常识值替换资料值。
${answerStyleRule(false)}`;
}

export function truncateKeepingHeadAndTail(
  rawText: string,
  maxChunkLen: number,
  marker = '... [中间内容超出篇幅限制截断] ...',
): string {
  const text = String(rawText || '');
  if (!text || text.length <= maxChunkLen) return text;
  if (maxChunkLen <= marker.length + 40) return smartTruncateChunkText(text, maxChunkLen);

  // Reserve at least a third of the allowance for the tail, bounded so a long
  // head is still the dominant part.
  const tailBudget = Math.max(200, Math.min(Math.floor(maxChunkLen * 0.45), maxChunkLen - marker.length - 20));
  const headBudget = Math.max(80, maxChunkLen - marker.length - tailBudget);
  const headRaw = text.slice(0, headBudget);
  // Trim the head to a line boundary so no table row or paragraph is cut in half.
  const headCut = headRaw.lastIndexOf('\n');
  const head = headCut >= Math.floor(headBudget * 0.6) ? headRaw.slice(0, headCut) : headRaw;
  const tailRaw = text.slice(-tailBudget);
  const tailStart = tailRaw.indexOf('\n');
  const tail = tailStart >= 0 && tailStart < Math.floor(tailRaw.length * 0.3) ? tailRaw.slice(tailStart + 1) : tailRaw;
  return `${head.trimEnd()}\n${marker}\n${tail.trimStart()}`;
}

export function smartTruncateChunkText(rawText: string, maxChunkLen: number): string {
  if (!rawText || rawText.length <= maxChunkLen) return rawText;

  const minSafe = Math.floor(maxChunkLen * 0.8);
  const candidateSlice = rawText.slice(0, maxChunkLen);

  // 1. Try paragraph break \n\n
  const lastDoubleNewline = candidateSlice.lastIndexOf('\n\n');
  if (lastDoubleNewline >= minSafe) {
    return `${candidateSlice.slice(0, lastDoubleNewline).trimEnd()}\n\n...[内容超出篇幅限制截断]`;
  }

  // 2. Try line break \n (crucial for markdown tables so rows are never split in half)
  const lastNewline = candidateSlice.lastIndexOf('\n');
  if (lastNewline >= minSafe) {
    const isTable = candidateSlice.includes('|');
    const suffix = isTable ? '\n| ... (表格后续行因篇幅限制截断) |\n' : '\n...[内容超出篇幅限制截断]';
    return `${candidateSlice.slice(0, lastNewline).trimEnd()}${suffix}`;
  }

  return `${candidateSlice.trimEnd()}...[内容超出篇幅限制截断]`;
}
