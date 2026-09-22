/**
 * 多跳关系抽取（Corpus-Agnostic）。
 * 从 chat.service 拆出，便于独立测试与配置注入。
 */
import { resolveRelationSurfaceForms } from './corpus-agnostic-config';

const RELATION_QUERY_RE =
  /\b(husband|wife|spouse|father|mother|parents|son|daughter|child|grandmother|grandfather|grandparent|grandparents|grandson|granddaughter|grandchild|grandchildren|sibling|brother|sister|uncle|aunt|nephew|niece|cousin|ancestor|ancestors|descendant|descendants|stepfather|stepmother|mother-in-law|father-in-law|son-in-law|daughter-in-law|director|directed|directs|direct|author|authored|writer|written|wrote|creator|created|founder|founded|composer|composed|producer|produced|born|birthplace|birth place|capital|headquarters|head office|graduated|alma mater|subsidiary|parent|starring|nationality|citizenship|country|died|place of death|cause of death|educated at|employer|owned by|owns|publisher|published by|distributor|original language|performer|genre|member of|team|located in|located|location|in charge|in charge of|leader|leader of|head of|governor|mayor|president|prime minister|monarch|king|queen|chairman|chief executive|ceo|owner|coach|captain|manages|managed by|buried|burial)\b|配偶|妻子|丈夫|父亲|母亲|父母|儿子|女儿|祖父|外祖父|祖母|外祖母|爷爷|外公|奶奶|外婆|孙子|孙女|曾祖父|祖先|后代|兄弟姐妹|哥哥|弟弟|姐姐|妹妹|叔叔|舅舅|姑姑|阿姨|侄子|侄女|堂兄|表亲|导演|执导|作者|编剧|创始人|成立时间|出生地|生于|毕业院校|母校|总部|省会|首都|所属|控股|主演|研发团队|国籍|出生国家|逝世地|去世地点|毕业学校|所属团队|效力于|雇主|母公司|子公司|位于|属于|发行商|出版社|演出|流派/i;

export function extractRelationFromQuery(query: string): string | null {
  if (!query) return null;
  const m = query.match(RELATION_QUERY_RE);
  return m ? m[0].toLowerCase() : null;
}

export function surfaceFormsForRelation(rel: string): string[] {
  const table = resolveRelationSurfaceForms();
  return Array.from(new Set([rel, ...(table[rel] || [])]));
}

export { RELATION_QUERY_RE };
