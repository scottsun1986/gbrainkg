/** Preserve all previous projections while replacing selected units. A
 * partial parser response is never published as the complete document. */
export function mergeSourceUnitRetry(previousMarkdown: string, previous: any, next: any, ids: string[]) {
  const wanted = new Set(ids);
  const oldUnits = previous.source_units || [];
  for (const unit of [...oldUnits, ...(next.source_units || [])]) if (typeof unit.anchor === 'string' && wanted.has(unit.anchor)) wanted.add(unit.id);
  const nextById = new Map<string,any>((next.source_units || []).filter((unit: any) => unit.status !== 'skipped').map((unit: any) => [unit.id, unit]));
  if (ids.some(id => !oldUnits.some((unit: any) => unit.id === id))) throw new Error('Retry source unit no longer exists');
  let markdown = previousMarkdown;
  const replacements: Array<{ start:number; end:number; text:string }> = [];
  const additions: string[] = [];
  const units = oldUnits.map((unit: any) => {
    if (!wanted.has(unit.id)) return { ...unit };
    const replacement = nextById.get(unit.id);
    if (!replacement) throw new Error(`Retry parser omitted selected source unit: ${unit.id}`);
    const merged = { ...unit, ...replacement };
    if (unit.reference_only || replacement.reference_only || replacement.status === 'failed') return { ...merged, markdown: unit.markdown || '' };
    const original = String(unit.markdown || ''); const text = String(replacement.markdown || '');
    if (original) {
      const trusted = Number.isInteger(unit.char_start) && Number.isInteger(unit.char_end) && markdown.slice(unit.char_start,unit.char_end) === original;
      const start = trusted ? unit.char_start : markdown.indexOf(original);
      // Repeated equal text requires a verified original-source offset.
      if (start < 0 || (!trusted && markdown.indexOf(original, start + original.length) >= 0)) throw new Error(`Retry unit position is ambiguous: ${unit.id}`);
      replacements.push({ start, end:start + original.length, text });
    } else if (text) additions.push(text);
    return merged;
  });
  for (const fresh of nextById.values()) if (wanted.has(fresh.id) && !oldUnits.some((unit:any)=>unit.id===fresh.id)) { units.push(fresh); if (!fresh.reference_only && fresh.markdown) additions.push(String(fresh.markdown)); }
  replacements.sort((a,b) => b.start - a.start);
  for (let i=0;i<replacements.length;i++) {
    const item=replacements[i]; if (i && item.end > replacements[i-1].start) throw new Error('Retry projections overlap');
    markdown=markdown.slice(0,item.start)+item.text+markdown.slice(item.end);
  }
  if (additions.length) markdown += '\n\n' + additions.join('\n\n');
  const sourceOrder = [...replacements].sort((a,b)=>a.start-b.start);
  const shiftBefore = (position:number) => sourceOrder.filter(item=>item.end<=position).reduce((shift,item)=>shift+item.text.length-(item.end-item.start),0);
  for (const unit of units) {
    const original=oldUnits.find((old:any)=>old.id===unit.id);
    const trusted=original && Number.isInteger(original.char_start) && Number.isInteger(original.char_end)
      && previousMarkdown.slice(original.char_start,original.char_end)===String(original.markdown || '');
    // Retain the exact occurrence even when two pages have equal projections.
    const mapped=trusted ? original.char_start+shiftBefore(original.char_start) : -1;
    const text=String(unit.markdown || '');
    const unique=text ? markdown.indexOf(text) : -1;
    const start=mapped>=0 && markdown.slice(mapped,mapped+text.length)===text ? mapped
      : unique>=0 && markdown.indexOf(text,unique+text.length)<0 ? unique : -1;
    if (start >= 0 && text) { unit.char_start = start; unit.char_end = start + text.length; }
    else { delete unit.char_start; delete unit.char_end; }
  }
  const mergeById = (old: any[], fresh: any[]) => {
    const map = new Map((old || []).map(item => [item.id, item]));
    for (const item of fresh || []) map.set(item.id, item);
    return [...map.values()];
  };
  const processed = units.filter((unit: any) => unit.status === 'processed' || unit.status === 'completed').length;
  const failed = units.filter((unit: any) => unit.status === 'failed').length;
  return { ...next, markdown, source_units:units, position_encoding:'utf16',
    assets:mergeById(previous.assets, next.assets), structured_tables:mergeById(previous.structured_tables, (next.structured_tables || []).filter((table:any)=>[...nextById.values()].some(unit=>wanted.has(unit.id) && (unit.table_id===table.id || unit.id===table.id)))),
    coverage:{ total:units.length, processed, failed, skipped:units.length-processed-failed },
    native_text_chars: units.filter((unit: any) => !unit.reference_only).reduce((n:number, unit:any)=>n+Number(unit.native_text_chars || 0),0),
    generated_text_chars:units.reduce((n:number, unit:any)=>n+Number(unit.generated_text_chars || 0),0) };
}

/** Python source offsets count Unicode code points, JS chunks use UTF16. */
export function normalizeSourceOffsets(parsed: any) {
  if (parsed.position_encoding === 'utf16') return parsed;
  const text = String(parsed.markdown || '');
  const offsets=[...new Set<number>((parsed.source_units || []).flatMap((unit:any)=>[unit.char_start,unit.char_end]).filter((value:any)=>Number.isInteger(value)&&value>=0))].sort((a,b)=>a-b);
  const map=new Map<number,number>();let point=0,utf16=0,index=0;
  for(const character of text) { while(index<offsets.length&&offsets[index]===point)map.set(offsets[index++],utf16);point++;utf16+=character.length; }
  while(index<offsets.length&&offsets[index]===point)map.set(offsets[index++],utf16);
  for(const unit of parsed.source_units || [])for(const key of ['char_start','char_end']) {
    if(map.has(unit[key]))unit[key]=map.get(unit[key]);else if(Number.isInteger(unit[key]))delete unit[key];
  }
  parsed.position_encoding = 'utf16';
  return parsed;
}
