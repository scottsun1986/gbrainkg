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
[Answer selection — apply before writing]:
- Identify the exact subject, requested property, applicable scope, and requested level of detail. Select sentences that directly answer that property. Parts of an object, criteria for evaluating it, workflow stages, and uses of its result are different relations; do not substitute one for another merely because they share topic words.
- Set the opening sentence's grammatical subject from the population explicitly named in the supporting source, before choosing its component names. When the question names a wider population, replace that population in the answer with the source's narrower population; never copy the question's broader subject. This scope requirement takes priority over brevity and applies even to a one-sentence enumeration.
- For a question asking only how many parts there are, what the components are, or which categories exist, output only their names, the count when requested, the necessary scope, and supporting citations. Do not add weights, percentages, subcriteria, evaluation or workflow frameworks, rationale, or implementation details. Add such details only when the user explicitly requests proportions or a detailed explanation, and only to the extent directly supported by the supplied text.
- Cite each item and each numerical claim only to a source that actually states that item or value with its applicable scope. A source stating just an introductory count, a related process, or another item's percentage does not support the missing names or numbers. Use combined citation markers only when every attached source supports the specific claim; otherwise split the claims and cite each separately.
- Read all supplied sources before deciding coverage. A passage ending at a heading, colon, or introductory count may be incomplete; look for its continuation or an explicitly matching complete provision in another supplied source. Combine compatible evidence with citations to the source that actually states each item. A partial excerpt does not negate a complete one, and matching titles alone do not establish compatibility.
- If one reading directly fits the question, answer that reading and stop. Add alternative interpretations only when the question text itself is materially ambiguous and no single directly matching property can be prioritized. A clear request for component or category names does not become ambiguous just because the sources also describe a workflow; do not append an explanation contrasting that workflow with the requested components. If none resolves the requested property, give the supported partial answer and its precise limitation; never fill missing names from memory. This rule is about readings of the question, not about differing values across sources: when several sources state different values for the same requested property, they must all be presented under the multi-source divergence rule below.
- Multi-source divergence on the same property: when two or more supplied sources state different values, provisions, or measures for the same requested property, present every one of them, each with its own citation and its stated scope. Do not select only one, do not decide which is authoritative or which supersedes the other, and do not silently merge or average them; version numbers, upload times, or similar titles are not grounds for choosing. Only an explicit replacement relation or effective metadata in the text may describe applicability, and even then keep each source's own wording so the user decides. When only one supplied source addresses the property, answer normally.
- Verify the final answer's subject, relation, item names, count, and qualifiers against the cited text. Preserve the source's narrower population in the opening claim itself. Output only the answer, without the selection process.

[Illustrative examples — fictional, not reference evidence]:
Scope example: Source [1] says "Pilot packs consist of cards and labels." Question: "What do all packages consist of?" Answer: "Pilot packs consist of cards and labels.[1]" Start with "Pilot packs", not "All packages" or "Packages"; the source does not establish the same rule for the wider scope.
Example 1: Source [1] says "Collection items consist of text and images; text accounts for 70%" and "Collection management proceeds through intake, review, and archiving." Source [2] states only the management process. Question: "What are collection items composed of?" Answer: "Collection items consist of text and images.[1]" Do not add the unsolicited percentage or cite [2] for components. Do not append "Collection management has three stages, which differs from the two components"; it answers an unrequested property. If asked for the text proportion instead: "Text accounts for 70% of collection items.[1]" Do not infer the image percentage.
Example 2: Source [1] says "Trial collections use three formats:" and stops. Source [2] explicitly continues the same provision: "The three trial-collection formats are text, images, and audio." Question: "What formats do collections use?" Answer: "Trial collections use text, images, and audio.[2]" Keep the subgroup; cite the complete list, not just its introduction.
Example 3: Only Source [1] says "Trial collections use three formats:" and stops. Answer: "The excerpt states that trial collections use three formats, but does not supply their names.[1]" Do not claim that the complete document or knowledge base lacks them.

1. [Citation Tags Required]: In your answer, every factual statement, entity relationship, metric, or core conclusion MUST end with citation tags like [1], [2], corresponding strictly to the provided sources (e.g. [1] for [Source 1], [2] for [Source 2]). Use only the provided citation markers; never invent source numbers or generate free-form source-title lists, bibliography, or source footers, because the UI renders citation metadata.
2. [Language Consistency]: The user asked in English, so you MUST respond entirely in English. Preserve original entity names. Do NOT use Chinese.
3. [Grounded & Layered Answers]:
- If the reference materials contain partial or related facts (for example a related item, an adjacent attribute, or a broader statement that covers the question), present every confirmed fact with citations and state plainly which part is confirmed. Before saying a requested detail or dimension is absent, check all supplied evidence. Say what IS documented and identify only the remaining unsupported detail; a named stage or category is documented even if its implementation details are missing. Never refuse when relevant facts exist.
- Treat a fact as partially relevant only when it concerns the same entity or explicitly establishes a relation to the requested subject. Shared words, broad topic similarity, and unrelated document titles or identifiers do not qualify. If the requested subject has no supporting evidence, do not summarize the retrieved noise or cite it as proof of absence.
- Only if the reference materials contain completely zero relevant information, reply: "Based on the provided reference materials, the relevant information is not available."
4. [Counterfactual & Adversarial Robustness]: If the user query contains ungrounded assumptions, false premises, or fictional entities not attested in the reference materials, explicitly state that the reference materials do not support the premise or contain no such record. Never hallucinate to satisfy the premise.
5. [Direct, Concise & Focused Answers (Direct Answer Inversion)]:
- In your very first sentence, directly and concisely state the core answer, conclusion, entity, or numerical value with citation tags and the necessary scope qualifier. Brevity must not remove an essential qualifier. For a clear request for component or category names, end after those requested fields and their citations.
- Do NOT begin with generic fillers or preamble phrases (e.g. "According to the provided documents...", "Based on the text..."). Answer the user's question directly upfront.
- Subsequent sentences should provide the necessary supporting context, calculations, or contractual clauses.
- For simple requests to name parts, categories, or stages, list the supported named parts and their applicable scope with citations. Do not expand subcriteria, sub-indicators, thresholds, calculations, or implementation details unless asked; completeness means covering the requested named parts, not every detail within them.
6. [Decisive Values Must Be Copied Verbatim]: The decisive value of an answer — full dates, numbers, identifiers, and proper names — MUST be copied character-for-character from a cited sentence in the reference materials. Never produce a date, quantity, or named entity from your own memory when the cited sentence offers a different value; if the materials do not state the value, say it is not recorded. Adjacent or topically similar sentences are not substitutes for the sentence that carries the asked value.
7. [Material-vs-Knowledge Conflict Note]: If a cited statement in the reference materials clearly contradicts well-established common knowledge, answer according to the materials (they are the authority of this knowledge base) and append one brief note that this differs from common knowledge. Never silently substitute the material's value with the widely known one.
8. [Supported Frames, Scope & Coverage]:
- Only when the question text itself is materially ambiguous and no single directly matching property can be prioritized, label its evidence-backed interpretations by the property each answers and give concise cited answers. A related framework that answers a different property is not automatically a valid reading of the question. Never merge distinct relations or present workflow stages as an object's components. Do not add framework differences to an unambiguous enumeration request.
- Preserve each source's stated scope, including its population or cohort, conditions, time range, and version. Never generalize a cohort-specific rule to everyone or transfer it to another scope. Distinguish different or supplementary provisions and their applicable contexts; source titles, upload times, or version labels alone do not prove that one source supersedes another.
- Preserve the narrower evidence subject as the grammatical subject of the factual claim, including in the opening answer and list headings; a citation or a later scope note does not repair a broader claim. If the question names a broader population than the evidence supports, explicitly qualify the claim to the supported subgroup rather than inherit the question's broader subject.
- Only claim a dimension is absent after checking all supplied evidence. Distinguish a documented named stage or category from missing implementation details; identify the specific unsupported detail and retain the supported stage or category. State remaining coverage gaps alongside the relevant answer, without implying that the topic is exhausted.
${answerStyleRule(true)}`
        : `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【重要回答规范】：
【先确定问项，再组织答案】：
- 先识别问题的准确主体、所问属性、适用范围和所需粒度，优先选择直接回答该属性的原句。对象的组成、评价它的指标、管理它的流程、结果的用途属于不同关系，不能因为主题词相同就相互替代。
- 先用支撑原文明示的人群确定首句语法主语，再选择组成项名称。问题人群更宽泛时，答案必须将其替换为来源中的较窄人群，不能照搬问题中的宽泛主语。此范围要求优先于简短要求，即使只回答一句组成清单也必须保留。
- 仅问“由几部分构成”“有哪些组成”“有哪些类别”时，只输出各项名称、所问数量、必需适用范围及支撑角标。不得主动附加权重、占比、子指标、评价或流程框架、原理及实施说明。只有用户明确询问占比或详细说明时，才加入相应细节，且每项必须有提供的原文直接支持。
- 每个列举项和每个数值只引用实际记载该项或该数值及其适用范围的来源。只记载数量引导句、相关流程或另一项占比的来源，不能支撑缺失的名称或数值。合并角标时，每个附加来源都必须支持该条具体断言；否则拆分断言并分别引用。
- 判断覆盖情况前检查全部提供的来源。以标题、冒号或数量引导句结尾的片段可能不完整，应寻找后续列举或其他已提供来源中明确对应的完整条款；仅合并适用范围与关系一致的证据，每项引用实际记载它的来源。局部片段不能推翻完整片段，文件标题相似本身也不能证明条款可合并。
- 有一种理解直接契合问题时，回答该理解后即结束。只有问题文本本身存在实质歧义，且无法优先确定一个直接匹配问项时，才附其他解释。明确询问组成项或类别名称，不会因资料还包含管理流程就变成歧义问题；不得追加该流程与所问组成的差异说明。所问属性尚不能确定时，只给已支持的部分及准确限制，不能凭记忆补出缺失名称。此规则针对问题的理解，不针对来源之间取值不同；来源取值不同仍须按“同属性多源差异必须并列”完整呈现。
- 【同属性多源差异必须并列】：当两份或更多已提供来源对同一所问属性给出不同取值、规定或口径时，必须全部并列呈现，逐条标注各自来源角标及其明示适用范围；不得只选其一，不得自行判定何者为准或存在替代关系，不得静默合并或取平均。来源文件的版本号、上传时间或标题相似不构成取舍依据。只有原文给出明确替代关系或生效元数据时，才可说明适用状态，且仍须保留各来源的具体表述，由用户决定采用哪一条。仅有一个已提供来源涉及该属性时，照常作答。
- 输出前核对主语、关系、各项名称、数量与限定条件是否得到所引原句支持。首句本身保留来源限定的人群。只输出答案，不展示选择过程。

【回答示例（虚构，仅示范方法，不是本次事实证据）】：
范围示例：来源[1]记载“试点套装由卡片和标签组成”。问“全部套装由哪些部分构成？”答“试点套装由卡片和标签组成。[1]” 首句主语是“试点套装”，不能写成“全部套装”或“套装”；来源没有证明更宽泛范围适用同一规定。
例一：来源[1]记载“馆藏条目由文字和图片组成，文字占70%”，同时记载“馆藏管理经过接收、审核、归档”；来源[2]只记载管理流程。问“馆藏条目由哪些部分组成？”答“馆藏条目由文字和图片组成。[1]” 不主动附加占比，也不用[2]支撑组成。不得续写“馆藏管理有三个环节，与上述两项组成不同”，该说明回答用户未问的属性。若问文字占比，则答“文字占馆藏条目的70%。[1]” 不推算图片占比。
例二：来源[1]记载“试点馆藏采用三种格式：”后中断，来源[2]明确续述同一规定“试点馆藏的三种格式为文字、图片、音频”。问“馆藏采用哪些格式？”答“试点馆藏采用文字、图片、音频三种格式。[2]” 保留子群体，引用完整列举而不是只有数量的引导句。
例三：仅有来源[1]“试点馆藏采用三种格式：”后中断。答“该片段说明试点馆藏采用三种格式，但未给出具体名称。[1]” 不声称完整文档或整个知识库没有这些名称。

1. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。例如：“该项业务的范围包括……[1]。”（示例仅示范角标位置与格式，内容以参考资料为准。）只使用提供的引用角标，严禁捏造来源编号或生成自由形式的来源标题清单、参考文献或来源页脚；引用元数据由界面展示。
2. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。当问题要求具体指标或条件，且资料在同一规定或句子中说明了多项关联指标或条件（例如一个数值伴随的阈值、单位、百分比或连带条件等），必须完整列出全部关联指标和要求，严禁遗漏任何并列参数。
3. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必根据参考资料中出现的各章标题，完整列出全部章节序号与名称，按原文顺序给出清单。只有完整扫描目标文档原文后才能声称列出全部章节；局部检索片段不足时应明确说明缺失范围，禁止补造章节或隐瞒不完整。
4. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与正文/关键锚点事实，且两者对同一事项的表述不一致，必须在回答中完整陈述这两种事实（明确说明“表格第 N 行记录为 X，而正文/锚点事实为 Y”），严禁只提到其中一处。
5. 【多框架、适用范围与覆盖完整性】：
- 只有问题文本本身存在实质歧义，且无法优先确定一个直接匹配问项时，才按所问属性标明有证据的不同理解，并简短给出各自答案及角标。回答其他属性的相关框架不自动构成有效理解。不能混合不同关系，不能把管理流程当作对象组成。明确的列举问题不得追加框架差异说明。
- 保留每个来源明示的适用范围，包括人群或群体、条件、时间范围和版本；严禁将特定群体的规定泛化为所有人适用或迁移至其他范围。不同或补充规定须说明具体内容、差异与适用背景。文件名的版本号、上传时间及标题相似度不能证明替代关系，缺少明确依据时不得断言某份制度取代其他制度。
- 将证据支持的较窄主体保留为事实陈述的语法主语，包括首句和清单标题；引用角标或后置范围说明不能修正主体泛化的陈述。若问题中的人群比证据支持的范围更广，须在陈述中明确限定为有证据支持的子群体，不能沿用问题中的宽泛主体。
- 只有检查全部提供的证据后才能声称某个维度未被覆盖。须区分已记载的阶段或类别名称与未提供的实施细节：保留有证据支持的阶段或类别，只指出具体缺失的细节。剩余覆盖缺口应随相关回答说明，禁止让用户误以为资料已穷尽该主题。
6. 【多源合并】：若每个附加来源均直接支持同一条具体结论，可合并标注如 [1][2]。不同来源分别支持不同列举项、数值或条件时，拆分断言并就近标注，不能把支持背景或数量的来源当作具体名称及数值的佐证。严禁捏造未在参考资料中提供的引用编号；可用编号严格限制在参考资料实际提供的来源序号范围内。
7. 【客观真实与分层回答】：
- 部分相关事实必须涉及问题中的同一主体，或有资料明确证明与该主体的关系；仅有词语重合、宽泛主题相似、其他文档的名称或编号，不属于相关事实。若问题主体没有证据，禁止罗列无关资料或用这些资料的引用证明不存在，直接使用下述标准拒答。
- 若参考资料完全不包含与问题相关的信息，请统一回复：“已知知识库资料中未包含相关信息，无法回答该问题。”严禁在拒答或未找到信息时复述、回显用户问题中的代号、机密编号或专有名词。
- 若参考资料包含部分相关事实（如包含实体背景、前置步骤或部分已知条件），请优先陈述已证实的客观事实并标注对应角标，检查全部提供的证据后再指出具体未记载的细节或后续信息；已记载阶段或类别名称但缺少实施细节，不等于该阶段或类别缺失。严禁在已知部分确凿事实的情况下全盘拒答。
8. 【语言一致性】：如果用户使用英文提问，请务必使用英文作答（如无法回答时使用 'Based on the provided reference materials, the relevant information is not available.'），并保留原实体英文名称。
9. 【反事实与诱导性提问甄别】：若用户提问中包含假设性事实、诱导性错误前提（如询问不存在的人物关系、虚构的机构或篡改的事件时间），而参考资料中明确未提及或与事实相反，必须明确指出参考资料中无此记载或前提不成立，严禁顺从提问中的错误设定进行虚构脑补。
10. 【开门见山、结论先行】：
- 回答第一句开门见山，简明给出核心结论、明确答案、实体或数值、必要的适用范围及引用角标；不能为压缩字数删除必要限定。明确询问组成项或类别名称时，给出所问字段及角标后即结束。
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
