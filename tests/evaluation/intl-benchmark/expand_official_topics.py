"""Select reproducible official topics while retaining the complete search corpus."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from standard_ir_eval import load_qrels
from paired_ir_eval import digest


def expand(source, target, count, seed='20261007', exclude_incomplete=False):
    source=Path(source);target=Path(target)
    if source.resolve()==target.resolve():raise ValueError('Output profile must not overwrite the official source directory')
    qrels_path=source/'qrels/test.tsv'
    qrels=load_qrels(qrels_path)
    queries={}
    with (source/'queries.jsonl').open() as stream:
        for line in stream:
            row=json.loads(line); qid=str(row['_id'])
            if qid in queries: raise ValueError('Duplicate official query ID')
            queries[qid]=row
    corpus=(source/'corpus.jsonl').resolve()
    corpus_ids=set()
    with corpus.open() as stream:
        for line in stream:
            row=json.loads(line);doc_id=str(row['_id'])
            if doc_id in corpus_ids:raise ValueError('Duplicate official corpus document ID')
            corpus_ids.add(doc_id)
    rejected=[];topics=[]
    for qid,labels in sorted(qrels.items()):
        positive=[doc for doc,score in labels.items() if score>0]
        missing=sorted(doc for doc in positive if doc not in corpus_ids)
        if qid not in queries or missing:
            rejected.append({'queryId':qid,'missingQuery':qid not in queries,'missingPositiveDocuments':missing})
        elif positive:topics.append(qid)
    if rejected and not exclude_incomplete:
        raise ValueError(f'{len(rejected)} incomplete official topics; strict default rejects them. Use explicit --exclude-incomplete to preserve all remaining positive labels and record exclusions.')
    if count<1 or count>len(topics): raise ValueError(f'Requested {count} topics; only {len(topics)} eligible official topics')
    selected=sorted(topics,key=lambda qid:hashlib.sha256(f'{seed}:{qid}'.encode()).hexdigest())[:count]
    target.mkdir(parents=True,exist_ok=True)
    with (target/'queries.jsonl').open('w') as stream:
        for qid in selected:stream.write(json.dumps(queries[qid],ensure_ascii=False)+'\n')
    with (target/'qrels.tsv').open('w') as stream:
        stream.write('query-id\tcorpus-id\tscore\n')
        for qid in selected:
            for doc,score in sorted(qrels[qid].items()):stream.write(f'{qid}\t{doc}\t{score}\n')
    (target/'excluded-topics.json').write_text(json.dumps(rejected,indent=2)+'\n')
    # Keep a complete runnable BEIR directory rather than a manifest pointing
    # at an ephemeral download. Distractors are retained without rewriting.
    if (target/'corpus.jsonl').resolve()!=corpus:shutil.copyfile(corpus,target/'corpus.jsonl')
    (target/'qrels').mkdir(exist_ok=True)
    shutil.copyfile(target/'qrels.tsv',target/'qrels/test.tsv')
    manifest={'profile':'official-topics-full-corpus-v1','seed':seed,'topics':count,'availableTopics':len(topics),'officialTopics':len(qrels),'corpusDocuments':len(corpus_ids),'inputScope':'full-distributed-official-corpus','corpus':str(corpus),'corpusHash':digest(corpus),'sourceQrelsHash':digest(qrels_path),'sourceQueriesHash':digest(source/'queries.jsonl'),'qrelsHash':digest(target/'qrels.tsv'),'queriesHash':digest(target/'queries.jsonl'),'exclusionPolicy':'explicit incomplete-topic exclusion; never remove positive judgments from retained topics' if exclude_incomplete else 'strict complete-source integrity','excludedTopicCount':len(rejected),'excludedTopics':rejected,'excludedTopicsHash':digest(target/'excluded-topics.json'),'leaderboardComparable':count==len(topics) and not rejected}
    manifest['profileCorpusHash']=digest(target/'corpus.jsonl')
    manifest['profileQrelsPath']='qrels/test.tsv'
    (target/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--out',required=True);parser.add_argument('--topics',type=int,default=1000);parser.add_argument('--seed',default='20261007');parser.add_argument('--exclude-incomplete',action='store_true')
    args=parser.parse_args();result=expand(args.source,args.out,args.topics,args.seed,args.exclude_incomplete)
    print(json.dumps({'topics':result['topics'],'inputScope':result['inputScope'],'leaderboardComparable':result['leaderboardComparable']}))
