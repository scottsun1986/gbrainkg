/**
 * Output hygiene for model text that is about to become a user-visible answer.
 *
 * Two failure modes were reproduced against the live test environment
 * (2026-09-20, MuSiQue / 2WikiMultiHopQA end-to-end runs):
 *
 *  1. A reasoning model streamed everything into `reasoning_content` and never
 *     emitted `content`. The "recover the answer from the reasoning tail"
 *     fallback then shipped raw planning text as the answer
 *     ("The answer is straightforward—just need to state the century…"), which
 *     both leaks the model's scratchpad to the user and silently pollutes
 *     benchmark numbers.
 *  2. An upstream gateway error ("The request was rejected because it was
 *     considered high risk") reached the answer stream and was displayed as an
 *     answer.
 *
 * The helpers below are deliberately corpus-agnostic: they recognise *shape*
 * (planning voice / transport failure), never a business entity or topic.
 */

import { answerTypeOf, matchesAnswerType } from "./bridge-rescue";

/** Planning / scratchpad voice. Kept narrow so real answers survive. */
const PLANNING_CUES: RegExp[] = [
  /\bhmm\b/i,
  /\blet['’]?s\b/i,
  /\blet me\b/i,
  /\bi (?:need|should|will|must|have|can)\b/i,
  /\bwe (?:need|should|must|can)\b/i,
  /\bthe user (?:is asking|asks|wants|said|question)/i,
  /\bthe (?:question|query) (?:is|asks|wants|means)/i,
  /\b(?:just|only) need(?: to)?\b/i,
  /\bstep[- ]?by[- ]?step\b/i,
  /\bthe answer is (?:straightforward|simple|obvious)\b/i,
  /\b(?:not need|doesn['’]?t need|don['’]?t need)(?: to)?\b/i,
  /\bas per the (?:guidelines|instructions)\b/i,
  /我们需要|我先|让我|用户(?:的)?问题|一步步|逐步|思考[:：]|用户想要/,
  // Observed verbatim in enterprise no-answer runs (2026-09-21): the model
  // narrated the request instead of answering it, and a fragment of that
  // narration was displayed as the answer.
  /用户(?:询问|提问|问的|要求)的?是?/,
  /我需要(?:先|严格|基于|说明|指出|确认)/,
  /^好的[，,]/,
  /下面我(?:来|将)/,
  /这(?:看起来)?(?:是|属于)一个[^。！？]{0,20}(?:问题|询问)/,
  /我的回答(?:应该|应当|需要)/,
  /我应该(?:直接)?(?:说明|回答|指出)/,
  /所以[，,](?:我|答案)/,
];

/**
 * Absence/process phrasings that double as legitimate answer content, so they
 * are evaluated per sentence with guards instead of matching anywhere:
 *   "However, the sources do not state the budget [1]." — cited absence claim
 *   "There are no further details in the materials."   — existential claim about
 *     the materials
 *   "We have two editions of this regulation."        — enumerated fact
 * Their planning-voice readings ("however, the sources don't say…" as scratchpad
 * narration, "no extra details needed", "we have to check the sources") are
 * uncited, not sentence-initial, or carry no entity, so they stay detected.
 */
const GUARDED_PLANNING_CUES: RegExp[] = [
  /^however,? the sources? (?:don['’]?t|do not|does not)\b/i,
  /\bno (?:extra|additional|further) (?:details|context|information)\b/i,
  /\bwe have\b/i,
];

/** Strong cues: text at or after one of these is scratchpad, not answer. */
const STRONG_PLANNING_CUES: RegExp[] = [
  /\bhmm\b/i,
  /\blet['’]?s\b/i,
  /\blet me\b/i,
  /\bi (?:need|should|will|must)\b/i,
  /\bwe (?:need|should|must)\b/i,
  /\bthe user (?:is asking|asks|wants|said)/i,
  /\b(?:just|only) need(?: to)?\b/i,
  /\bstep[- ]?by[- ]?step\b/i,
  /\bthe answer is (?:straightforward|simple|obvious)\b/i,
  /我们需要|我先|让我|用户(?:的)?问题|一步步|思考[:：]/,
  /用户(?:询问|提问|问的|要求)的?是?/,
  /我需要(?:先|严格|基于|说明|指出|确认)/,
  /^好的[，,]/,
  /下面我(?:来|将)/,
  /这(?:看起来)?(?:是|属于)一个[^。！？]{0,20}(?:问题|询问)/,
  /我的回答(?:应该|应当|需要)/,
  /我应该(?:直接)?(?:说明|回答|指出)/,
  /所以[，,](?:我|答案)/,
];

/** Transport / gateway failures that must never be shown as an answer. */
const PROVIDER_ERROR_CUES: RegExp[] = [
  /request was rejected/i,
  /\bconsidered high[- ]risk\b/i,
  /\brate limit (?:reached|exceeded|hit)\b/i,
  /\btoo many requests\b/i,
  /\binsufficient (?:balance|quota|credit)\b/i,
  /\bcontext length exceeded\b/i,
  /\b(?:internal server error|service unavailable|bad gateway|gateway timeout)\b/i,
  /\bapi key (?:is )?(?:invalid|missing|expired)\b/i,
  /\bmodel not found\b/i,
  /请求被拒绝|触发限流|超出(?:上下文|长度)限制/,
];

/** Minimum length for recovered text to count as a drafted answer. */
const MIN_DRAFT_CHARS = 20;

/** Split into trimmed non-empty sentences (Latin and CJK terminals). */
function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?。！？；;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "There are no further details …" — an existence claim about the materials. */
const EXISTENTIAL_ABSENCE =
  /\bthere\s+(?:are|is|were|was)\s+no\s+(?:extra|additional|further)\s+(?:details|context|information)\b/i;

/**
 * A sentence carries a number or a named entity. The leading "We" of a
 * "we have …" sentence is excluded so the whitelist cannot fire on the
 * sentence's own subject. Ordinal adverbs ("first", "second") are NOT
 * numbers here — "we have to check the sources first" is planning voice.
 */
function hasNumberOrEntity(sentence: string): boolean {
  const rest = sentence.replace(/^we\s+/i, '');
  return /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty)\b|\p{Lu})/u.test(
    rest,
  );
}

/**
 * True when a sentence matches a guarded absence/process cue in its
 * planning-voice reading: uncited, and (for "we have") without any number or
 * entity to anchor a factual statement.
 */
function isGuardedPlanningSentence(sentence: string): boolean {
  if (!GUARDED_PLANNING_CUES.some((pattern) => pattern.test(sentence))) return false;
  // A cited sentence is real content, whatever process words it contains.
  if (/\[\d+\]/.test(sentence)) return false;
  // "There are no further details …" asserts absence in the materials —
  // an answer, not scratchpad.
  if (EXISTENTIAL_ABSENCE.test(sentence)) return false;
  // "We have two editions of this regulation" states a fact; only the
  // process reading ("we have to check…") is planning voice.
  if (/\bwe have\b/i.test(sentence) && hasNumberOrEntity(sentence)) return false;
  return true;
}

/**
 * True when the text mostly re-states the user's question instead of answering
 * it. Observed on the answer-only retry path (MuSiQue, 2026-09-20), where the
 * model returned `First, the user asked: "What century did the author of …"`.
 * A citation-bearing sentence is exempt: quoting the question while citing
 * evidence is a legitimate form of answer.
 */
/**
 * Meta-discourse: a sentence talking *about* the request instead of answering it
 * ("我注意到用户在问题末尾加了「24」…根据规范要求我不应复显这类信息").
 *
 * Enumerating phrasings was measurably insufficient — each enterprise run
 * produced a new one, and the fragments reached users as the answer (15 of 30
 * "unanswerable" cases in one run). The structural rule is: a sentence that
 * mentions the user / the question / the instructions is scratchpad *unless* it
 * carries a citation marker, which is what a real knowledge-base answer does.
 */
const META_DISCOURSE_CUES: RegExp[] = [
  /用户/, /提问/, /问题末尾/, /问题中/, /测试用例/, /规范要求/, /复显/, /不应复显/,
  // Narration shapes only: "the user asked/added/wants…". The bare cue
  // `\bthe user\b` false-positived on technical vocabulary ("The user manual
  // specifies…"), and `\bprompt\b` / `\binstructions?\b` matched ordinary
  // corpus words, so they are dropped; "user manual" is covered by the
  // compound shape below never firing.
  /\bthe user\s+(?:asked|asks|added|adds|wants|wanted|said|says|tells|told|requires?|wished|noted|wrote|mentioned|included|provided)\b/i,
  /\bthe question (?:adds|says|asks|ends)\b/i,
  /\btest case\b/i,
  /\baccording to the instructions?\b/i,
];

export function looksLikeMetaDiscourse(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  if (/\[\d+\]/.test(body)) return false; // a cited statement is real content
  return META_DISCOURSE_CUES.some((pattern) => pattern.test(body));
}

export function looksLikeQuestionEcho(text: string, question: string): boolean {
  const body = (text || '').trim();
  const prompt = (question || '').trim();
  if (!body || !prompt) return false;
  if (/\[\d+\]/.test(body)) return false;
  const lower = body.toLowerCase();
  const words = prompt.replace(/["'“”]/g, '').split(/\s+/).filter((w) => w.length > 2);
  if (words.length >= 4) {
    const covered = words.filter((w) => lower.includes(w.toLowerCase())).length;
    return covered / words.length >= 0.8;
  }
  // CJK (and other unsegmented scripts): compare on characters.
  if (!/\s/.test(prompt) && prompt.length >= 8) {
    // A factual answer often repeats the question's subject and verb but
    // replaces the interrogative tail with the fact. Prefix-only matching
    // would discard exactly that answer; require the full question wording.
    const wording = prompt.replace(/[。？！?!]+$/u, '').trim();
    return wording.length >= 8 && lower.includes(wording.toLowerCase());
  }
  return false;
}

function countMatches(patterns: RegExp[], text: string): number {
  return patterns.reduce((total, pattern) => (pattern.test(text) ? total + 1 : total), 0);
}

/** True when the text reads as the model planning, not as an answer. */
export function isPlanningLikeText(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return true;
  if (countMatches(PLANNING_CUES, body) > 0) return true;
  // Guarded absence/process phrasings count only in their planning-voice
  // reading (uncited, non-sentence-initial, or entity-free sentences).
  return splitSentences(body).some((sentence) => isGuardedPlanningSentence(sentence));
}

/** True when the text is an upstream transport/gateway failure message. */
export function isProviderErrorText(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  return countMatches(PROVIDER_ERROR_CUES, body) > 0;
}

function hasSubstance(text: string, question?: string): boolean {
  const body = (text || '').trim();
  if (body.replace(/\s+/g, '').length < MIN_DRAFT_CHARS) {
    // The 20-char floor existed to keep fragments out of the answer, but it
    // also discarded real short answers: "Paris." (6 chars) or "1978 [1]".
    // A fragment that carries a citation marker is a cited fact, and one that
    // already matches the type of fact the question asks for is an answer.
    if (/\[\d+\]/.test(body)) return true;
    const type = question ? answerTypeOf(question) : 'unknown';
    return type !== 'unknown' && matchesAnswerType(body, type);
  }
  // A whole paragraph of punctuation/emoji is not an answer either.
  return /[\p{L}\p{N}]{3,}/u.test(body);
}

/**
 * Recover a user-visible answer from a reasoning trace.
 *
 * Strategy: keep the *prefix* that precedes the first strong planning cue (a
 * model often drafts the answer first and then keeps thinking), and drop the
 * scratchpad that follows. Reject the result when it is itself planning voice,
 * is an upstream error, or carries no substance — an honest empty answer beats
 * a leaked scratchpad, both for users and for scoring.
 */
export function extractAnswerFromReasoning(reasoning: string, question?: string): string {
  const text = (reasoning || '').trim();
  if (!text) return '';
  // A trace that starts from a gateway failure carries nothing trustworthy.
  if (isProviderErrorText(text)) return '';

  let cut = text.length;
  for (const pattern of STRONG_PLANNING_CUES) {
    const match = pattern.exec(text);
    if (match && match.index >= 0 && match.index < cut) cut = match.index;
  }
  // Guarded cues cut at the start of the sentence that carries them, so a
  // cited absence claim ("However, the sources do not state the budget [1].")
  // survives while scratchpad narration is still dropped.
  for (const sentence of splitSentences(text)) {
    if (!isGuardedPlanningSentence(sentence)) continue;
    const start = text.indexOf(sentence);
    if (start >= 0 && start < cut) cut = start;
  }
  let candidate = text.slice(0, cut).trim();

  // Nothing preceded the cue: fall back to the last paragraph, which is where
  // a drafting cue such as "答案：" would leave the final text.
  if (!candidate) {
    const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    candidate = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : '';
  }

  candidate = candidate.replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
  if (!hasSubstance(candidate, question)) return '';
  if (isPlanningLikeText(candidate)) return '';
  if (isProviderErrorText(candidate)) return '';
  return candidate;
}
