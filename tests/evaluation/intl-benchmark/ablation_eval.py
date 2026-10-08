"""Collect explicit experiment commands and compare paired, fully declared runs.

No service configuration or deployment changes. Collection is opt-in. Run and
judgement contracts are documented in ABLATION.md. Reuses official IR metrics.
"""
import argparse
import json
import math
import random
import subprocess
from pathlib import Path
from paired_ir_eval import digest, interval, percentile
from standard_ir_eval import load_qrels, METRIC_FUNCS

FIXED = ('chunker', 'embedding', 'reranker', 'generator', 'judge', 'pricing', 'budget', 'concurrency', 'cache')
QUALITY = ('ndcg', 'recall', 'mrr', 'map', 'chainRecall', 'chainComplete', 'factSupport', 'citationAccuracy',
           'answerAccuracy', 'falseRefusal', 'unsupportedAnswer', 'success')
RESOURCE = ('modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'cost', 'latencyMs', 'visibleMs')


def jsonl(path):
    rows = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip(): continue
        row = json.loads(line); qid = str(row.get('qid', ''))
        if not qid or qid in rows: raise ValueError('Missing or duplicate qid')
        rows[qid] = row
    return rows


def finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Invalid ' + name)
    return value


def boolean(row, key):
    if not isinstance(row.get(key), bool): raise ValueError('Missing boolean ' + key)
    return row[key]


def ratio(row, numerator, denominator):
    a = finite(row.get(numerator), numerator); b = finite(row.get(denominator), denominator)
    if a > b or not float(a).is_integer() or not float(b).is_integer(): raise ValueError('Invalid grade counts')
    return a/b if b else None


def score(row, label, qrels, k, pricing):
    docs = row.get('docids')
    if not isinstance(docs, list) or any(not isinstance(doc, str) or not doc for doc in docs): raise ValueError('Missing/invalid ranking')
    grades = row.get('grading', {})
    supported = ratio(grades, 'supportedClaims', 'totalClaims')
    citations = ratio(grades, 'correctCitations', 'totalCitations')
    answer_correct = boolean(grades, 'answerCorrect'); refused = boolean(grades, 'refused')
    success = boolean(row, 'success'); answerable = boolean(label, 'answerable')
    chains = label.get('evidenceChains', [])
    if not isinstance(chains, list) or any(not isinstance(chain, list) or not chain for chain in chains):
        raise ValueError('Invalid independently labeled evidence chains')
    retrieved = set(docs[:k])
    coverage = max((len(retrieved.intersection(chain))/len(set(chain)) for chain in chains), default=None)
    metrics = {metric: fn(docs, qrels, k) for metric, fn in METRIC_FUNCS.items()}
    metrics.update(chainRecall=coverage, chainComplete=int(coverage == 1) if coverage is not None else None,
        factSupport=supported, citationAccuracy=citations, answerAccuracy=int(answer_correct),
        falseRefusal=int(refused) if answerable and success else None,
        unsupportedAnswer=int(not refused and not answer_correct) if not answerable and success else None, success=int(success))
    usage = row.get('usage', {})
    metrics.update({key: finite(usage.get(key), key) for key in RESOURCE if key != 'cost'})
    if any(not float(metrics[key]).is_integer() for key in ('modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens')): raise ValueError('Noninteger usage counters')
    if metrics['cachedInputTokens'] > metrics['inputTokens']: raise ValueError('Cached input exceeds total input')
    by_model = usage.get('byModel')
    if not isinstance(by_model, dict) or not by_model: raise ValueError('Missing per-model usage')
    cost = 0; totals = dict.fromkeys(('inputTokens', 'cachedInputTokens', 'outputTokens', 'modelCalls'), 0)
    for model, counts in by_model.items():
        if model not in pricing['models']: raise ValueError('Missing model price: ' + model)
        rate = pricing['models'][model]
        for key in totals: totals[key] += finite(counts.get(key), key)
        if counts['cachedInputTokens'] > counts['inputTokens']: raise ValueError('Invalid model cached usage')
        cost += ((counts['inputTokens']-counts['cachedInputTokens'])*rate['inputPerMillion']
            + counts['cachedInputTokens']*rate['cachedInputPerMillion'] + counts['outputTokens']*rate['outputPerMillion'])/1_000_000
    if any(totals[key] != metrics[key] for key in totals): raise ValueError('Total and per-model usage differ')
    metrics['cost'] = cost
    return metrics


def evaluate(manifest, k=10, resamples=5000, seed=20261008):
    if manifest.get('fixture') or manifest.get('dry_run'): raise ValueError('Synthetic results cannot establish efficacy')
    protocol = manifest.get('protocol', {})
    if any(not protocol.get(key) for key in FIXED): raise ValueError('Incomplete fixed protocol')
    pricing = protocol['pricing']
    if not isinstance(pricing.get('models'), dict) or not pricing['models']: raise ValueError('Missing per-model pricing')
    for rate in pricing['models'].values():
        for key in ('inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'): finite(rate.get(key), key)
    if not pricing.get('currency'): raise ValueError('Missing cost currency')
    variants = manifest.get('variants', []); datasets = manifest.get('datasets', [])
    names = [v['name'] for v in variants]
    if len(names) < 2 or len(set(names)) != len(names) or manifest.get('baseline') not in names: raise ValueError('Missing baseline/ablation')
    if not datasets or len({d['name'] for d in datasets}) != len(datasets): raise ValueError('Missing/duplicate dataset')
    rng = random.Random(seed); alpha = .05/((len(variants)-1)*len(datasets)*(len(QUALITY)+len(RESOURCE)))
    report = {'protocol': protocol, 'seed': seed, 'k': k, 'resamples': resamples, 'baseline': manifest['baseline'],
        'method': 'paired query bootstrap of repeat means; simultaneous family 95% Bonferroni intervals', 'datasets': []}
    for variant in variants:
        provenance = variant.get('provenance', {})
        if any(not provenance.get(key) for key in ('gitCommit', 'workingTreeHash', 'modelFingerprint', 'judgeFingerprint')):
            raise ValueError('Incomplete source/model/judge provenance')
        if variant.get('protocol') != protocol: raise ValueError('Protocol differs between variants')
    reference = next(v['provenance'] for v in variants if v['name'] == manifest['baseline'])
    if any(v['provenance'][key] != reference[key] for v in variants for key in ('modelFingerprint', 'judgeFingerprint')):
        raise ValueError('Model or judge fingerprint differs between variants')
    report['variants'] = [{key: v[key] for key in ('name', 'features', 'provenance')} for v in variants]
    for dataset in datasets:
        qrels = load_qrels(Path(dataset['qrels'])); labels = jsonl(dataset['labels']); topics = sorted(labels)
        if not topics or set(qrels) != set(topics): raise ValueError('Labels and qrels must cover identical full topics')
        result = {'name': dataset['name'], 'topics': len(topics), 'inputScope': dataset.get('inputScope', 'unverified'),
            'hashes': {key: digest(dataset[key]) for key in ('corpus', 'queries', 'qrels', 'labels')}, 'variants': {}, 'comparisons': {}}
        scored = {}; repeat_count = None
        for variant in variants:
            paths = variant['runs'][dataset['name']]
            if not paths or (repeat_count is not None and len(paths) != repeat_count): raise ValueError('Unpaired repetitions')
            repeat_count = len(paths); runs = [jsonl(path) for path in paths]
            if any(set(run) != set(topics) for run in runs): raise ValueError('Every run must contain every topic, including failures')
            metrics = {qid: [score(run[qid], labels[qid], qrels[qid], k, pricing) for run in runs] for qid in topics}
            means = {metric: {qid: sum(values)/len(values) for qid in topics
                if (values := [row[metric] for row in metrics[qid] if row[metric] is not None])} for metric in QUALITY+RESOURCE}
            scored[variant['name']] = means
            summary = {metric: {'mean': sum(values.values())/len(values) if values else None, 'topics': len(values)} for metric, values in means.items()}
            for metric in ('latencyMs', 'visibleMs', 'cost'):
                values = [row[metric] for rows in metrics.values() for row in rows]
                summary[metric].update({key: percentile(values, p) for key, p in (('p50', .5), ('p95', .95), ('p99', .99))})
            result['variants'][variant['name']] = {'repeats': len(paths), 'hashes': [digest(path) for path in paths], 'metrics': summary}
        baseline = scored[manifest['baseline']]
        for name, candidate in scored.items():
            if name == manifest['baseline']: continue
            comparison = {}
            for metric in QUALITY+RESOURCE:
                old = baseline[metric]; new = candidate[metric]; paired = sorted(set(old).intersection(new))
                delta = [new[qid]-old[qid] for qid in paired]
                comparison[metric] = {'pairedTopics': len(delta), 'delta': sum(delta)/len(delta) if delta else None,
                    'deltaSimultaneous95': interval(delta, rng, resamples, alpha) if len(delta) > 1 else None}
            result['comparisons'][name] = comparison
        report['datasets'].append(result)
    return report


def collect(manifest, root):
    for variant in manifest['variants']:
        command = variant.get('command')
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) for arg in command):
            raise ValueError('Collection requires an explicit argv command per variant')
        for dataset in manifest['datasets']:
            for repeat, output in enumerate(variant['runs'][dataset['name']]):
                path = Path(root, output)
                if path.exists(): raise ValueError('Refusing to overwrite a run artifact')
                path.parent.mkdir(parents=True, exist_ok=True)
                argv = [arg.format(dataset=dataset['name'], repeat=repeat, out=str(path.resolve())) for arg in command]
                subprocess.run(argv, cwd=root, check=True, timeout=manifest.get('collectionTimeoutSeconds', 3600))
                if not path.is_file(): raise ValueError('Collector did not produce the declared run')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True); parser.add_argument('--out', required=True)
    parser.add_argument('--collect', action='store_true'); parser.add_argument('--k', type=int, default=10)
    parser.add_argument('--resamples', type=int, default=5000); parser.add_argument('--seed', type=int, default=20261008)
    args = parser.parse_args()
    if args.k < 1 or args.resamples < 1000: parser.error('Invalid statistical settings')
    manifest_path = Path(args.manifest).resolve(); manifest = json.loads(manifest_path.read_text())
    if args.collect: collect(manifest, manifest_path.parent)
    # Data paths are relative to the manifest, not the caller's shell directory.
    for dataset in manifest['datasets']:
        for key in ('corpus', 'queries', 'qrels', 'labels'): dataset[key] = str(manifest_path.parent / dataset[key])
    for variant in manifest['variants']:
        variant['runs'] = {name: [str(manifest_path.parent / path) for path in paths] for name, paths in variant['runs'].items()}
    report = evaluate(manifest, args.k, args.resamples, args.seed)
    report['manifestHash'] = digest(manifest_path)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'datasets': len(report['datasets']), 'variants': len(report['variants'])}))
