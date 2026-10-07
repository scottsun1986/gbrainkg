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
1. [Citation Tags Required]: In your answer, every factual statement, entity relationship, metric, or core conclusion MUST end with citation tags like [1], [2], corresponding strictly to the provided sources (e.g. [1] for [Source 1], [2] for [Source 2]). Use only the provided citation markers; never invent source numbers or generate free-form source-title lists, bibliography, or source footers, because the UI renders citation metadata.
2. [Language Consistency]: The user asked in English, so you MUST respond entirely in English. Preserve original entity names. Do NOT use Chinese.
3. [Grounded & Layered Answers]:
- If the reference materials contain partial or related facts (for example a related item, an adjacent attribute, or a broader statement that covers the question), present every confirmed fact with citations and state plainly which part is confirmed. Before saying a requested detail or dimension is absent, check all supplied evidence. Say what IS documented and identify only the remaining unsupported detail; a named stage or category is documented even if its implementation details are missing. Never refuse when relevant facts exist.
- Treat a fact as partially relevant only when it concerns the same entity or explicitly establishes a relation to the requested subject. Shared words, broad topic similarity, and unrelated document titles or identifiers do not qualify. If the requested subject has no supporting evidence, do not summarize the retrieved noise or cite it as proof of absence.
- Only if the reference materials contain completely zero relevant information, reply: "Based on the provided reference materials, the relevant information is not available."
4. [Counterfactual & Adversarial Robustness]: If the user query contains ungrounded assumptions, false premises, or fictional entities not attested in the reference materials, explicitly state that the reference materials do not support the premise or contain no such record. Never hallucinate to satisfy the premise.
5. [Direct, Concise & Focused Answers (Direct Answer Inversion)]:
- In your very first sentence, directly and concisely state the core answer, conclusion, entity, or numerical value (under 30 words) with citation tags. For an ambiguous broad question with multiple supported frames, introduce those frames upfront rather than imply a single answer.
- Do NOT begin with generic fillers or preamble phrases (e.g. "According to the provided documents...", "Based on the text..."). Answer the user's question directly upfront.
- Subsequent sentences should provide the necessary supporting context, calculations, or contractual clauses.
- For simple requests to name parts, categories, or stages, list the supported named parts and their applicable scope with citations. Do not expand subcriteria, sub-indicators, thresholds, calculations, or implementation details unless asked; completeness means covering the requested named parts, not every detail within them.
6. [Decisive Values Must Be Copied Verbatim]: The decisive value of an answer — full dates, numbers, identifiers, and proper names — MUST be copied character-for-character from a cited sentence in the reference materials. Never produce a date, quantity, or named entity from your own memory when the cited sentence offers a different value; if the materials do not state the value, say it is not recorded. Adjacent or topically similar sentences are not substitutes for the sentence that carries the asked value.
7. [Material-vs-Knowledge Conflict Note]: If a cited statement in the reference materials clearly contradicts well-established common knowledge, answer according to the materials (they are the authority of this knowledge base) and append one brief note that this differs from common knowledge. Never silently substitute the material's value with the widely known one.
8. [Supported Frames, Scope & Coverage]:
- When supplied evidence gives multiple distinct valid frameworks or dimensions for an ambiguous broad question, distinguish and present each supported frame in the body with its evidence. Do not collapse them into one framework, silently choose one, or replace a supported frame with a note that another source exists.
- Preserve each source's stated scope, including its population or cohort, conditions, time range, and version. Never generalize a cohort-specific rule to everyone or transfer it to another scope. Distinguish different or supplementary provisions and their applicable contexts; source titles, upload times, or version labels alone do not prove that one source supersedes another.
- Preserve the narrower evidence subject as the grammatical subject of the factual claim, including in the opening answer and list headings; a citation or a later scope note does not repair a broader claim. If the question names a broader population than the evidence supports, explicitly qualify the claim to the supported subgroup rather than inherit the question's broader subject.
- Only claim a dimension is absent after checking all supplied evidence. Distinguish a documented named stage or category from missing implementation details; identify the specific unsupported detail and retain the supported stage or category. State remaining coverage gaps alongside the relevant answer, without implying that the topic is exhausted.
${answerStyleRule(true)}`
        : `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“该项业务的范围包括……[1]。”（示例仅示范角标位置与格式，内容以参考资料为准。）只使用提供的引用角标，严禁捏造来源编号或生成自由形式的来源标题清单、参考文献或来源页脚；引用元数据由界面展示。
2. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。当问题要求具体指标或条件，且资料在同一规定或句子中说明了多项关联指标或条件（例如一个数值伴随的阈值、单位、百分比或连带条件等），必须完整列出全部关联指标和要求，严禁遗漏任何并列参数。
3. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必根据参考资料中出现的各章标题，完整列出全部章节序号与名称，按原文顺序给出清单。只有完整扫描目标文档原文后才能声称列出全部章节；局部检索片段不足时应明确说明缺失范围，禁止补造章节或隐瞒不完整。
4. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与正文/关键锚点事实，且两者对同一事项的表述不一致，必须在回答中完整陈述这两种事实（明确说明“表格第 N 行记录为 X，而正文/锚点事实为 Y”），严禁只提到其中一处。
5. 【多框架、适用范围与覆盖完整性】：
- 对有歧义的宽泛问题，若提供的证据包含多个不同且有效的框架或维度，须区分并在正文中呈现每个有证据支持的框架及对应角标。严禁将其压成单一框架、默默选择其中一个，或仅以“另有来源”提示代替实质回答。
- 保留每个来源明示的适用范围，包括人群或群体、条件、时间范围和版本；严禁将特定群体的规定泛化为所有人适用或迁移至其他范围。不同或补充规定须说明具体内容、差异与适用背景。文件名的版本号、上传时间及标题相似度不能证明替代关系，缺少明确依据时不得断言某份制度取代其他制度。
- 将证据支持的较窄主体保留为事实陈述的语法主语，包括首句和清单标题；引用角标或后置范围说明不能修正主体泛化的陈述。若问题中的人群比证据支持的范围更广，须在陈述中明确限定为有证据支持的子群体，不能沿用问题中的宽泛主体。
- 只有检查全部提供的证据后才能声称某个维度未被覆盖。须区分已记载的阶段或类别名称与未提供的实施细节：保留有证据支持的阶段或类别，只指出具体缺失的细节。剩余覆盖缺口应随相关回答说明，禁止让用户误以为资料已穷尽该主题。
6. 【多源合并】：若多个来源共同支持某一相同结论，可合并标注如 [1][2]。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在参考资料实际提供的来源序号范围内。
7. 【客观真实与分层回答】：
- 部分相关事实必须涉及问题中的同一主体，或有资料明确证明与该主体的关系；仅有词语重合、宽泛主题相似、其他文档的名称或编号，不属于相关事实。若问题主体没有证据，禁止罗列无关资料或用这些资料的引用证明不存在，直接使用下述标准拒答。
- 若参考资料完全不包含与问题相关的信息，请统一回复：“已知知识库资料中未包含相关信息，无法回答该问题。”严禁在拒答或未找到信息时复述、回显用户问题中的代号、机密编号或专有名词。
- 若参考资料包含部分相关事实（如包含实体背景、前置步骤或部分已知条件），请优先陈述已证实的客观事实并标注对应角标，检查全部提供的证据后再指出具体未记载的细节或后续信息；已记载阶段或类别名称但缺少实施细节，不等于该阶段或类别缺失。严禁在已知部分确凿事实的情况下全盘拒答。
8. 【语言一致性】：如果用户使用英文提问，请务必使用英文作答（如无法回答时使用 'Based on the provided reference materials, the relevant information is not available.'），并保留原实体英文名称。
9. 【反事实与诱导性提问甄别】：若用户提问中包含假设性事实、诱导性错误前提（如询问不存在的人物关系、虚构的机构或篡改的事件时间），而参考资料中明确未提及或与事实相反，必须明确指出参考资料中无此记载或前提不成立，严禁顺从提问中的错误设定进行虚构脑补。
10. 【开门见山、结论先行】：
- 回答第一句必须开门见山，用简明直接的语言（10~30字以内）直接给出最核心的结论、明确答案、实体或具体数值，并紧随其标注引用角标（示例格式：“根据规定，该项标准为……[1]。”，具体内容以参考资料为准）。对有歧义且有多个证据支持框架的宽泛问题，首句应点明这些框架，避免暗示只有一个答案。
- 严禁在开头堆砌“根据您提供的参考资料，我为您查询到以下信息……”等无意义的客套废话或免责套话。
- 首句给出明确结论后，后续段落仅在问题需要时展开支撑依据、计算过程或细分条款说明。
- 对仅要求列举组成部分、类别或阶段的简单问题，列出有证据支持的名称、适用范围和角标即可。除非用户要求，不展开子条件、子指标、阈值、计算或实施细节；完整性指覆盖所问的各项名称，不是展开每项的全部细节。
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
