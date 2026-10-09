import { detectLanguage } from '../ingestion/content-dedupe';

export interface QaCandidate { id:string; kbId:string; qa:{question:string;answer:string;scope?:string;language?:string;effectiveFrom?:string;effectiveTo?:string} }
const normalized=(value:string)=>value.normalize('NFKC').toLowerCase().trim();
function stated(query:string, label:string) {
  const text=normalized(query), value=normalized(label);
  if (!value) return true;
  if (Array.from(value).length>=3) return text.includes(value);
  const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,'u').test(text);
}

/** Exact operator-provided scope labels are reusable across corpora. Never
 * invent a business synonym or select a contradictory answer by score. */
export function resolveQaApplicability(candidates:QaCandidate[],query:string) {
  const groups=new Map<string,QaCandidate[]>(); const allowed=new Set<string>(); const ambiguities:Array<{question:string;scopes:string[];languages:string[]}> = [];
  for(const candidate of candidates) { const key=`${candidate.kbId}:${normalized(candidate.qa.question)}`;const group=groups.get(key)||[];group.push(candidate);groups.set(key,group); }
  const queryLanguage=detectLanguage(query);
  for(const group of groups.values()) {
    let selected=group.filter(candidate=>!candidate.qa.scope||stated(query,candidate.qa.scope));
    const explicitLanguage=selected.filter(candidate=>candidate.qa.language&&stated(query,candidate.qa.language));
    if(explicitLanguage.length)selected=explicitLanguage;
    else {
      const matching=selected.filter(candidate=>!candidate.qa.language||normalized(candidate.qa.language).split('-')[0]===queryLanguage);
      if(matching.length)selected=matching;
    }
    const answers=new Set(selected.map(candidate=>candidate.qa.answer));
    if(!selected.length||answers.size>1) {
      ambiguities.push({question:group[0].qa.question,scopes:[...new Set(group.map(candidate=>candidate.qa.scope||'通用'))],languages:[...new Set(group.map(candidate=>candidate.qa.language||'未指定'))]});
    } else for(const candidate of selected)allowed.add(candidate.id);
  }
  return {allowed,ambiguities};
}
