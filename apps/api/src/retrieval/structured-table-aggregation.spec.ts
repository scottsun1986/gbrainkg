import { aggregateStructuredTable } from './structured-table-aggregation';
import { StructuredTable } from '../ingestion/source-artifacts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const table=(values:any[],format='0.00'):StructuredTable=>({id:'facts',sheet:'Sheet',range:'D1:E5',header_columns:[4,5],headers:['key','amount'],row_count:values.length,complete:true,mode:'small',rows:values.map((value,i)=>({row:i+2,cells:[{coordinate:`D${i+2}`,column:4,type:'string',value:`k${i}`},{coordinate:`E${i+2}`,column:5,type:'number',value,number_format:format}]}))});
describe('complete structured table calculation',()=>{
  it('uses absolute region columns rather than sparse array indices',async()=>{
    const source=table([0,1.1,2.2]);expect(await aggregateStructuredTable(source,'doc','sum',1)).toMatchObject({value:'3.3',coverage:1});
    source.rows[0].cells=source.rows[0].cells.slice(1);expect(await aggregateStructuredTable(source,'doc','count',undefined,[{column:0,operator:'eq',value:'k0'}])).toMatchObject({value:'0'});
  });
  it('never counts inherited merge values twice and refuses missing formula caches',async()=>{
    const source=table([5,5]);source.rows[1].cells[1].inherited=true;
    expect(await aggregateStructuredTable(source,'doc','sum',1)).toMatchObject({value:'5'});
    source.rows[0].cells[1]={...source.rows[0].cells[1],value:null,formula:'=SUM(A1:A2)'};
    await expect(aggregateStructuredTable(source,'doc','sum',1)).rejects.toThrow('no calculable');
  });
  it('reports percent display units and rejects mixed currencies',async()=>{
    expect(await aggregateStructuredTable(table([0.15,0.2],'0.0%'),'doc','sum',1)).toMatchObject({value:'35',unit:'%'});
    const source=table([1,2],'$0.00');source.rows[1].cells[1].number_format='€0.00';
    await expect(aggregateStructuredTable(source,'doc','sum',1)).rejects.toThrow('Mixed units');
    const literal=table(['20%','15%']);literal.rows.forEach(row=>{row.cells[1].type='string';});
    expect(await aggregateStructuredTable(literal,'doc','sum',1)).toMatchObject({value:'35',unit:'%'});
    const declared=table([1,2]);declared.headers[1]='金额（万元）';declared.header_units=[null,'万元'];
    expect(await aggregateStructuredTable(declared,'doc','sum',1)).toMatchObject({value:'3',unit:'万元'});
  });
  it('streams all rows beyond the search preview and verifies hash/coverage',async()=>{
    const previous=process.env.UPLOAD_ROOT;const root=await mkdtemp(join(tmpdir(),'typed-table-'));process.env.UPLOAD_ROOT=root;
    try {
      await mkdir(join(root,'doc'));const source=table(Array.from({length:1000},(_,i)=>i));const bytes=source.rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
      await writeFile(join(root,'doc','facts.jsonl'),bytes);source.rows=source.rows.slice(0,2);source.artifact_path='doc/facts.jsonl';source.sha256=createHash('sha256').update(bytes).digest('hex');
      expect(await aggregateStructuredTable(source,'doc','sum',1)).toMatchObject({value:'499500',rowsRead:1000});
      source.sha256='bad';await expect(aggregateStructuredTable(source,'doc','count')).rejects.toThrow('hash mismatch');
      source.artifact_path='../foreign/facts';await expect(aggregateStructuredTable(source,'doc','count')).rejects.toThrow('Invalid structured');
    } finally { if(previous===undefined)delete process.env.UPLOAD_ROOT;else process.env.UPLOAD_ROOT=previous;await rm(root,{recursive:true,force:true}); }
  });
});
