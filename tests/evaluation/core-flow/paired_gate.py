"""Paired, bucketed quality/latency/cost gate. No online defaults or synthetic SOTA claims."""
import argparse
import hashlib
import json
import math
import random
from pathlib import Path

REQUIRED = ('correctness', 'citation_precision', 'fact_coverage', 'evidence_coverage', 'unauthorized', 'span_correct', 'latency_ms', 'cost_usd')
def quantile(values, q):
    ordered = sorted(values)
    if not ordered:
        raise ValueError('Empty evaluation bucket')
    return ordered[min(len(ordered)-1, math.ceil((len(ordered)-1)*q))]

def paired_interval(left, right, metric, seed=20260930, samples=3000):
    values = [b[metric]-a[metric] for a,b in zip(left,right)]
    rng = random.Random(seed)
    means = [sum(rng.choice(values) for _ in values)/len(values) for _ in range(samples)]
    return [quantile(means,.025), quantile(means,.975)]

def load(path):
    data = json.loads(Path(path).read_text())
    if data.get('dry_run') or data.get('fixture') or not data.get('runId') or not data.get('gitCommit') or not data.get('workingTreeHash') or not data.get('corpusHash') or not data.get('policyVersion') or not data.get('modelFingerprints'):
        raise ValueError('Missing reproducible run provenance or fixture is not eligible for gating')
    cases = data.get('cases', [])
    ids = [case.get('id') for case in cases]
    if not cases or len(set(ids)) != len(ids) or not all(ids):
        raise ValueError('Missing/duplicate evaluation cases')
    for case in cases:
        if not case.get('bucket') or not case.get('authorizationScopeHash') or not case.get('asOf') or any(key not in case or not isinstance(case[key],(int,float)) or not math.isfinite(case[key]) for key in REQUIRED):
            raise ValueError('Incomplete quality, authorization, time, latency or real cost evidence')
        if case['latency_ms']<0 or case['cost_usd']<0 or any(not 0<=case[key]<=1 for key in REQUIRED[:6]):
            raise ValueError('Invalid metric range')
    return data

def compare(baseline, candidate, min_cases=1000, min_bucket=50, require_multihop=False):
    if baseline['corpusHash'] != candidate['corpusHash'] or baseline['policyVersion'] != candidate['policyVersion']:
        raise ValueError('Corpus/policy mismatch; runs cannot be paired')
    old={c['id']:c for c in baseline['cases']};new={c['id']:c for c in candidate['cases']}
    if old.keys()!=new.keys():
        raise ValueError('Baseline/candidate cases differ')
    failures=[];buckets={}
    if len(new)<min_cases: failures.append('insufficient_total_cases')
    keys=sorted(new)
    for key in keys:
        if any(old[key][field]!=new[key][field] for field in ('bucket','authorizationScopeHash','asOf')):
            raise ValueError('Paired authorization/time/bucket mismatch')
    for bucket in sorted({c['bucket'] for c in new.values()}):
        selected=[key for key in keys if new[key]['bucket']==bucket]
        a=[old[key] for key in selected];b=[new[key] for key in selected]
        row={'cases':len(b),'delta95':{metric:paired_interval(a,b,metric) for metric in ('correctness','citation_precision','fact_coverage','evidence_coverage')}}
        if len(b)<min_bucket:failures.append(f'{bucket}:insufficient_cases')
        for metric,interval in row['delta95'].items():
            if interval[0]<-.01:failures.append(f'{bucket}:{metric}:noninferiority_not_established')
        if bucket=='multi_hop' and require_multihop:
            gain=sum(y['evidence_coverage']-x['evidence_coverage'] for x,y in zip(a,b))/len(a)
            if gain<.05 or row['delta95']['evidence_coverage'][0]<=0:failures.append('multi_hop:gain_not_established')
        buckets[bucket]=row
    if require_multihop and 'multi_hop' not in buckets: failures.append('multi_hop:missing_bucket')
    rows=[new[k] for k in keys]
    aggregate={key:sum(row[key] for row in rows)/len(rows) for key in REQUIRED if key not in ('latency_ms','cost_usd')}
    for key, floor in [('correctness',.95),('citation_precision',.98),('fact_coverage',.95),('span_correct',1)]:
        if aggregate[key]<floor:failures.append(f'{key}:absolute_floor')
    if any(row['unauthorized'] for row in rows):failures.append('unauthorized_content')
    old95=quantile([old[k]['latency_ms'] for k in keys],.95);new95=quantile([new[k]['latency_ms'] for k in keys],.95)
    oldcost=sum(old[k]['cost_usd'] for k in keys);newcost=sum(new[k]['cost_usd'] for k in keys)
    if old95<=0 or oldcost<=0:failures.append('invalid_baseline_resource_cost')
    elif new95>old95*.75 or newcost>oldcost*.75:failures.append('25_percent_latency_cost_target_not_met')
    return {'passes':not failures,'failures':failures,'cases':len(rows),'metrics':aggregate,'latency_p95_ms':{'baseline':old95,'candidate':new95},'total_cost_usd':{'baseline':oldcost,'candidate':newcost},'buckets':buckets}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline',required=True);parser.add_argument('--candidate',required=True);parser.add_argument('--out',required=True);parser.add_argument('--require-multihop-gain',action='store_true')
    args=parser.parse_args()
    baseline=load(args.baseline);candidate=load(args.candidate)
    report=compare(baseline,candidate,require_multihop=args.require_multihop_gain)
    report['inputs']={key:hashlib.sha256(Path(path).read_bytes()).hexdigest() for key,path in [('baseline',args.baseline),('candidate',args.candidate)]}
    Path(args.out).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passes':report['passes'],'failures':report['failures']},ensure_ascii=False))
    raise SystemExit(0 if report['passes'] else 1)
