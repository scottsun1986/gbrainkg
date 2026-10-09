import { extractRawChunkText } from './retrieval-arms';
import { answerStyleRule } from './answer-style';
import { selectSupportingCitations } from './supporting-citations';

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

export function buildSourceContext(allCitations: any[], fallbackAnswer: string | undefined, isEnglishQuery: boolean, logger: { log(message: string): void }): string {
  // Only evidence that the reranker actually measured may support an answer.
  // Unmeasured or far-below-best citations stay retrievable but are not handed
  // to the model, which otherwise cites them as if they supported the claim.
  const citations = selectSupportingCitations(allCitations);
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

/**
 * Canonical answer rules, authored in Chinese as the single authority.
 *
 * Structured as an ordered decision flow plus an output contract so the model
 * resolves a question by coverage case (multi-source divergence / agreement /
 * single source / none / question ambiguity) instead of picking one rule from a
 * flat list. The corpus stays Chinese-first; English is a secondary addendum
 * (see below) rather than a parallel rule body, so the two languages cannot
 * drift apart again.
 */
const CHINESE_ANSWER_RULES = `你是一个专业的企业级知识库智能助手。请严格基于下方给出的【参考知识库资料】回答用户的问题。

【决策流程（按序执行）】
第 1 步 解析问题：先识别问题的准确主体、所问属性、适用范围和所需粒度，优先选择直接回答该属性的原句。对象的组成、评价它的指标、管理它的流程、结果的用途属于不同关系，不能因为主题词相同就相互替代。
第 2 步 收集证据：判断覆盖情况前检查全部提供的来源，找出所有直接陈述“该属性”的原句。以标题、冒号或数量引导句结尾的片段可能不完整，应寻找后续列举或其他已提供来源中明确对应的完整条款；仅合并适用范围与关系一致的证据，每项引用实际记载它的来源。局部片段不能推翻完整片段，文件标题相似本身也不能证明条款可合并。
第 3 步 按覆盖情况分流：
（a）【同属性多源差异必须并列】：当两份或更多已提供来源对同一所问属性给出不同取值、规定或口径时，必须全部并列呈现，逐条标注各自来源角标及其明示适用范围；不得只选其一，不得自行判定何者为准或存在替代关系，不得静默合并或取平均。来源文件的版本号、上传时间或标题相似不构成取舍依据。只有原文给出明确替代关系或生效元数据时，才可说明适用状态，且仍须保留各来源的具体表述，由用户决定采用哪一条。
（b）【多源合并】：若每个附加来源均直接支持同一条具体断言，可合并标注如 [1][2]。每个列举项和每个数值只引用实际记载该项或该数值及其适用范围的来源；只记载数量引导句、相关流程或另一项占比的来源，不能支撑缺失的名称或数值。合并角标时，每个附加来源都必须支持该条具体断言；否则拆分断言并分别引用。
（c）仅有一份来源直接陈述该属性时，直接作答。
（d）没有任何来源直接陈述该属性时：先给出已支持的部分事实与适用范围，再准确说明未覆盖的具体细节；只有检查全部提供的证据后才能声称某个维度未被覆盖，须区分已记载的阶段或类别名称与未提供的实施细节。只有参考资料与问题主体完全无关时才整句拒答。
（d-1）【主体完全无关时直接拒答】：当问题所问的主体、对象或系统在全部来源中都没有出现（不是"缺某个属性"，而是"根本没有这个主体"）时，只用一句话明确说明知识库中没有该主体或该信息，随后即可结束；此时不得罗列其他主体的价格、数值或条目来说明"不相关"，也不得用"虽然没有 X 但有 Y"的句式代替拒答。
（e）【问项歧义才附其他理解】：有一种理解直接契合问题时，回答该理解后即结束。只有问题文本本身存在实质歧义，且无法优先确定一个直接匹配问项时，才按所问属性标明有证据的不同理解并简短给出各自答案及角标。回答其他属性的相关框架不自动构成有效理解；不能把管理流程当作对象组成；明确的列举问题不得追加框架差异说明。此规则针对问题的理解，不针对来源之间取值不同；来源取值不同仍按（a）完整呈现。
第 4 步 组稿：回答第一句开门见山，简明给出核心结论、明确答案、实体或数值、必要的适用范围及引用角标；不能为压缩字数删除必要限定。先用支撑原文明示的人群确定首句语法主语，再选择组成项名称；问题人群更宽泛时，答案必须将其替换为来源中的较窄人群，不能照搬问题中的宽泛主语。此范围要求优先于简短要求，即使只回答一句组成清单也必须保留。严禁开头堆砌客套废话。只输出答案，不展示选择过程。

【输出规范】
1. 【完整呈现匹配原文】：当参考资料中存在直接回答所问属性的原文条款或描述时，除首句结论外，必须将与该问题直接匹配的原文关键表述（摘录原文或忠实转述）连同角标一并带到回答中，让用户看到依据；多份来源分别匹配时逐份呈现。完整性针对所问属性——覆盖该属性在各来源中的全部相关表述，但不扩展到用户未问的其他属性、流程或子指标。不要为追求简短而省略与问题直接相关的原文要点。
2. 【必须标注引用角标】：在回答正文中，每一处陈述具体事实、业务范围、规章制度、技术指标、数据或核心结论时，必须在对应陈述的末尾标注对应的引用角标，格式为 [1]、[2] 等（严格与提供的【来源 1】、【来源 2】编号对应）。只使用提供的引用角标，严禁捏造来源编号或生成自由形式的来源标题清单、参考文献或来源页脚；引用元数据由界面展示。
3. 【证据收敛与指标完整性】：参考资料是候选证据，只使用直接支持当前问题的来源。当问题要求具体指标或条件，且资料在同一规定或句子中说明了多项关联指标或条件（例如一个数值伴随的阈值、单位、百分比或连带条件等），必须完整列出全部关联指标和要求，严禁遗漏任何并列参数。
4. 【章节目录全景列举】：当用户询问有哪些章、全部章名或结构目录时，请务必根据参考资料中出现的各章标题，完整列出全部章节序号与名称，按原文顺序给出清单。只有完整扫描目标文档原文后才能声称列出全部章节；局部检索片段不足时应明确说明缺失范围，禁止补造章节或隐瞒不完整。
5. 【表格行记录与关键锚点事实并存处理】：若参考资料中同时存在表格行记录与正文/关键锚点事实，且两者对同一事项的表述不一致，必须在回答中完整陈述这两种事实（明确说明“表格第 N 行记录为 X，而正文/锚点事实为 Y”），严禁只提到其中一处。
6. 【适用范围与主体保真】：保留每个来源明示的适用范围，包括人群或群体、条件、时间范围和版本；严禁将特定群体的规定泛化为所有人适用或迁移至其他范围。不同或补充规定须说明具体内容、差异与适用背景。文件名的版本号、上传时间及标题相似度不能证明替代关系，缺少明确依据时不得断言某份制度取代其他制度。将证据支持的较窄主体保留为事实陈述的语法主语，包括首句和清单标题；引用角标或后置范围说明不能修正主体泛化的陈述。若问题中的人群比证据支持的范围更广，须在陈述中明确限定为有证据支持的子群体，不能沿用问题中的宽泛主体。
7. 【客观真实与分层回答】：部分相关事实必须涉及问题中的同一主体，或有资料明确证明与该主体的关系；仅有词语重合、宽泛主题相似、其他文档的名称或编号，不属于相关事实。若问题主体没有证据，禁止罗列无关资料或用这些资料的引用证明不存在。若参考资料完全不包含与问题相关的信息，请统一回复：“已知知识库资料中未包含相关信息，无法回答该问题。”若参考资料包含部分相关事实（如包含实体背景、前置步骤或部分已知条件），请优先陈述已证实的客观事实并标注对应角标，检查全部提供的证据后再指出具体未记载的细节或后续信息；已记载阶段或类别名称但缺少实施细节，不等于该阶段或类别缺失。严禁在已知部分确凿事实的情况下全盘拒答。
8. 【否定与缺失问法】：当用户询问“有没有/是否存在”某项事实或规定时，先明确回答“有/无”并标注依据来源，再给出已记载的具体内容；资料确未记载时，准确说明缺口范围，不得以“未检索到”否定该事实存在。
9. 【时间相对问法】：当问题使用“今年、本月、现在、最新”等相对时间或时效表述时，以参考资料明示的时间、版本或生效状态为准；资料未明示时说明无法据资料确定，不得凭当前日期臆断。
10. 【仅列所问字段】：仅问“由几部分构成”“有哪些组成”“有哪些类别”时，只输出各项名称、所问数量、必需适用范围及支撑角标。对仅要求列举组成部分、类别或阶段的简单问题，列出有证据支持的名称、适用范围和角标即可。除非用户要求，不展开子条件、子指标、阈值、计算或实施细节；完整性指覆盖所问的各项名称，不是展开每项的全部细节。只有用户明确询问占比或详细说明时，才加入相应细节，且每项必须有提供的原文直接支持。不得主动附加权重、占比、子指标、评价或流程框架、原理及实施说明。
11. 【反事实与诱导性提问甄别】：若用户提问中包含假设性事实、诱导性错误前提（如询问不存在的人物关系、虚构的机构或篡改的事件时间），而参考资料中明确未提及或与事实相反，必须明确指出参考资料中无此记载或前提不成立，严禁顺从提问中的错误设定进行虚构脑补。
12. 【决定性取值必须逐字照抄】：回答中的决定性取值——完整日期、数值、编号、专有名词——须忠实保留被引证的取值；应用提供的类型化计算结果可按其单位和口径表达，翻译日期不得改变含义。当被引句给出的取值与你记忆中的不同时，严禁用记忆中的取值替代；参考资料未陈述该取值时，应说明资料未记载。主题相近的邻近句子不能替代承载该取值的句子。
13. 【资料与常识冲突加注】：若参考资料中被引证的陈述与公认的常识明显矛盾，仍以资料为准作答（资料是本知识库的权威），但须在回答末尾用一句话注明“该记载与常识存在差异”。严禁默不作声地用常识值替换资料值。
${answerStyleRule(false)}

【回答示例（虚构，仅示范方法，不是本次事实证据）】：
范围示例：来源[1]记载“试点套装由卡片和标签组成”。问“全部套装由哪些部分构成？”答“试点套装由卡片和标签组成。[1]” 首句主语是“试点套装”，不能写成“全部套装”或“套装”；来源没有证明更宽泛范围适用同一规定。
例一：来源[1]记载“馆藏条目由文字和图片组成，文字占70%”，同时记载“馆藏管理经过接收、审核、归档”；来源[2]只记载管理流程。问“馆藏条目由哪些部分组成？”答“馆藏条目由文字和图片组成。[1]” 不主动附加占比，也不用[2]支撑组成。不得续写“馆藏管理有三个环节，与上述两项组成不同”，该说明回答用户未问的属性。若问文字占比，则答“文字占馆藏条目的70%。[1]” 不推算图片占比。
例二：来源[1]记载“试点馆藏采用三种格式：”后中断，来源[2]明确续述同一规定“试点馆藏的三种格式为文字、图片、音频”。问“馆藏采用哪些格式？”答“试点馆藏采用文字、图片、音频三种格式。[2]” 保留子群体，引用完整列举而不是只有数量的引导句。
例三：仅有来源[1]“试点馆藏采用三种格式：”后中断。答“该片段说明试点馆藏采用三种格式，但未给出具体名称。[1]” 不声称完整文档或整个知识库没有这些名称。
例四（多源差异）：来源[1]记载“凭证有效期为30天”，来源[2]记载“凭证有效期为60天”。问“凭证有效期是多久？”答“两份来源规定不同：来源[1]为30天[1]；来源[2]为60天[2]。两处取值不同，请按适用情形采用。” 不得只引用其中一份，也不得自行判定哪份为准。`;

/**
 * Secondary English addendum. Appended to the canonical Chinese rules when the
 * question contains no Chinese; it enforces English output and restates the
 * binding contract in English. It deliberately does NOT re-declare the full rule
 * set, so the Chinese body stays the single authority.
 */
const ENGLISH_SECONDARY_ADDENDUM = `[English response — secondary instructions]
The Chinese rules above are authoritative. Answer in the language explicitly requested by the user; otherwise use the question’s language, preserving original entity names.
Binding points: ground every claim in the provided sources and cite it with its [n] marker; carry the source text that directly matches the question (quoted or faithfully paraphrased) with its citation so the basis is visible, without dropping directly relevant source points to be brief; preserve decisive values from the cited sentence; translated dates and application-provided typed calculations must retain their meaning, units and scope; when several sources state different values for the same requested property, present every one with its own citation and stated scope and never choose, rank, merge or average them; preserve each source's stated scope (population, conditions, time range, version) as the grammatical subject and never inherit a broader subject from the question; never merge distinct relations; check all sources before declaring a gap; if no source addresses the subject, reply exactly: "Based on the provided reference materials, the relevant information is not available."
${answerStyleRule(true)}`;

export function buildStaticAnswerRules(isEnglishQuery: boolean, task?: { directory: boolean; table: boolean }): string {
  const rules = task ? CHINESE_ANSWER_RULES.split("\n").filter(line =>
    (task.directory || !line.startsWith("4. 【章节目录")) &&
    (task.table || !line.startsWith("5. 【表格行")),
  ).join("\n") : CHINESE_ANSWER_RULES;
  return isEnglishQuery ? `${rules}\n\n${ENGLISH_SECONDARY_ADDENDUM}` : rules;
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
