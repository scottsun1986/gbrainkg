/** Shared, corpus-agnostic answer length policy for the grounded chat prompt. */
export function answerStyleRule(isEnglishQuery: boolean): string {
  return isEnglishQuery
    ? '- For a simple question asking for one fact, answer in one or two short sentences including the citation. Include only context needed to identify or qualify that fact; do not restate the question or add unrelated background. When the user asks for details, a comparison, steps, or multiple facts, address every requested part with the necessary supporting evidence.'
    : '- 对只询问一个事实的简单问题，默认用一至两句短句直接作答并标注引用；仅补充识别或限定该事实所必需的背景，不复述问题，不添加无关介绍。若用户要求详细说明、比较、步骤或多个事实，应逐项完整回答并给出必要证据。';
}
