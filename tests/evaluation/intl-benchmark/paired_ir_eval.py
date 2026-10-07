"""Official-qrels, query-paired repeated-run bootstrap across arbitrary corpora.

Manifest: datasets:[{name,qrels,corpus,queries,baseline:[run.jsonl,...],candidate:[...] }],
baselineProvenance/candidateProvenance:{gitCommit,workingTreeHash,modelFingerprint}.
No API calls. Empty submitted rankings count as zero; incomplete topics fail closed.
"""
import argparse
import hashlib
import json
import math
import random
from pathlib import Path
from standard_ir_eval import load_qrels, METRIC_FUNCS


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): result.update(chunk)
    return result.hexdigest()


def ranking(path):
    rows = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip(): continue
        row = json.loads(line)
        qid = str(row.get('qid') or row.get('query_id') or '')
        docs = row.get('docids', row.get('doc_ids'))
        if not qid or qid in rows or not isinstance(docs, list): raise ValueError('Missing/duplicate topic or ranking list')
        rows[qid] = list(dict.fromkeys(str(doc) for doc in docs))
    return rows


def percentile(values, probability):
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position); upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def interval(deltas, rng, resamples, alpha):
    means = [sum(rng.choice(deltas) for _ in deltas)/len(deltas) for _ in range(resamples)]
    return [percentile(means, alpha/2), percentile(means, 1-alpha/2)]


def evaluate(manifest, k=10, resamples=5000, seed=20261007, margin=.01):
    if manifest.get('dry_run') or manifest.get('fixture'): raise ValueError('Synthetic runs are ineligible')
    for side in ('baselineProvenance', 'candidateProvenance'):
        if not all(manifest.get(side, {}).get(key) for key in ('gitCommit', 'workingTreeHash', 'modelFingerprint')): raise ValueError('Missing revision/model provenance')
    datasets = manifest.get('datasets', [])
    if not datasets or len({row['name'] for row in datasets}) != len(datasets): raise ValueError('Missing/duplicate corpora')
    metrics = ('ndcg', 'mrr', 'recall', 'map')
    alpha = .05/(len(datasets)*len(metrics))
    report = {'method': 'paired query bootstrap of mean repeated-run metric; percentile interpolation; Bonferroni simultaneous 95% family', 'seed': seed, 'resamples': resamples, 'k': k, 'datasets': [], 'passes': True}
    rng = random.Random(seed)
    for dataset in datasets:
        qrels = load_qrels(Path(dataset['qrels']))
        topics = sorted(qid for qid, labels in qrels.items() if any(score>0 for score in labels.values()))
        if not topics: raise ValueError('At least one independently labeled topic required')
        old = [ranking(path) for path in dataset['baseline']]; new = [ranking(path) for path in dataset['candidate']]
        if len(old) != len(new) or not old: raise ValueError('Paired repetitions differ')
        if any(set(run) != set(topics) for run in old + new): raise ValueError('Every repeat must submit the complete declared qrels topic set')
        # Hash actual source files, including the full search corpus. Hashes do
        # not certify an API used that corpus: report inputScope explicitly.
        row = {'dataset': dataset['name'], 'topics': len(topics), 'repeats': len(old), 'inputScope': dataset.get('inputScope', 'unverified'), 'hashes': {key:digest(dataset[key]) for key in ('qrels', 'queries', 'corpus')}, 'runs': {side:[digest(path) for path in dataset[side]] for side in ('baseline', 'candidate')}, 'metrics': {}}
        for metric in metrics:
            fn = METRIC_FUNCS[metric]
            a = [sum(fn(run[qid], qrels[qid], k) for run in old)/len(old) for qid in topics]
            b = [sum(fn(run[qid], qrels[qid], k) for run in new)/len(new) for qid in topics]
            differences = [y-x for x,y in zip(a,b)]
            marginal = interval(differences, rng, resamples, .05) if len(topics)>1 else None
            simultaneous = interval(differences, rng, resamples, alpha) if len(topics)>1 else None
            established = simultaneous is not None and simultaneous[0]>=-margin
            row['metrics'][metric] = {'baseline':sum(a)/len(a), 'candidate':sum(b)/len(b), 'delta':sum(differences)/len(differences), 'delta95':marginal, 'deltaSimultaneous95':simultaneous, 'noninferiority_established':established}
            if not established: report['passes'] = False
        if len(topics)<2:row['inferenceBlocker']='Only one labeled topic; corpus metrics are descriptive and no query-level confidence interval is identifiable'
        report['datasets'].append(row)
    report['macroDatasetDelta'] = {metric:sum(row['metrics'][metric]['delta'] for row in report['datasets'])/len(datasets) for metric in metrics}
    report['provenance'] = {side:manifest[side] for side in ('baselineProvenance', 'candidateProvenance')}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True); parser.add_argument('--out', required=True)
    parser.add_argument('--k', type=int, default=10); parser.add_argument('--resamples', type=int, default=5000)
    parser.add_argument('--seed', type=int, default=20261007); parser.add_argument('--margin', type=float, default=.01)
    args = parser.parse_args()
    if args.k<1 or args.resamples<1000 or not 0<=args.margin<=1: parser.error('Invalid statistical settings')
    result = evaluate(json.loads(Path(args.manifest).read_text()), args.k, args.resamples, args.seed, args.margin)
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'passes':result['passes'], 'datasets':len(result['datasets'])}))
    raise SystemExit(0 if result['passes'] else 1)
