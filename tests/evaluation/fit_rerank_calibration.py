"""Fit a deployment-pinned Platt profile with a disjoint labeled holdout.

Input contract rerank-labels-v1: route/model/revision/corpusHash/cases, each
case:{id,score,supported:bool}. Train labels alone determine coefficients;
holdout measures refusal/answer precision and recall at a declared threshold.
No model/network calls and no synthetic deployment parameters.
"""
import argparse
import hashlib
import json
import math
import random
from pathlib import Path


def probability(score, slope, intercept):
    return 1/(1+math.exp(-max(-40,min(40,slope*score+intercept))))


def fit(rows, steps=100):
    mean=sum(row['score'] for row in rows)/len(rows)
    scale=math.sqrt(sum((row['score']-mean)**2 for row in rows)/len(rows))
    if scale<=1e-12:raise ValueError('Constant reranker scores cannot be calibrated')
    points=[((row['score']-mean)/scale,int(row['supported'])) for row in rows]
    slope=0.;intercept=0.;ridge=.001
    for _ in range(steps):
        ga=ridge*slope;gb=0.;haa=ridge;hab=0.;hbb=1e-8
        for score,label in points:
            p=probability(score,slope,intercept);weight=max(1e-9,p*(1-p))
            ga+=(p-label)*score;gb+=p-label;haa+=weight*score*score;hab+=weight*score;hbb+=weight
        determinant=haa*hbb-hab*hab
        da=(hbb*ga-hab*gb)/determinant;db=(haa*gb-hab*ga)/determinant
        # Bounded Newton steps avoid numerical blow-ups on near separation.
        factor=min(1,5/max(abs(da),abs(db),1e-12))
        slope-=factor*da;intercept-=factor*db
        if max(abs(da),abs(db))<1e-7:break
    if slope<=0 or not all(math.isfinite(value) for value in (slope,intercept)):raise ValueError('Nonpositive/invalid monotone calibration; inspect score orientation')
    return slope/scale,intercept-slope*mean/scale


def wilson(successes, total):
    if not total:return None
    p=successes/total;z=1.95996398454;den=1+z*z/total
    center=(p+z*z/(2*total))/den
    radius=z*math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den
    return [center-radius,center+radius]


def calibrate(data, seed='20261007', threshold=.95, allow_unversioned_diagnostics=False):
    if data.get('contract')!='rerank-labels-v1' or data.get('fixture') or data.get('dry_run') or data.get('complete') is False:raise ValueError('Need complete actual labeled reranker output')
    required=('model','corpusHash') if allow_unversioned_diagnostics else ('model','revision','corpusHash')
    if not all(isinstance(data.get(key),str) and data[key].strip() for key in required) or not any(isinstance(data.get(key),str) and data[key].strip() for key in ('route','routeHash')):raise ValueError('Missing deployment/corpus identity')
    if data.get('routeHash') and (len(data['routeHash'])!=64 or any(c not in '0123456789abcdef' for c in data['routeHash'])):raise ValueError('Invalid route hash')
    rows=data.get('cases',[])
    if len({row.get('id') for row in rows})!=len(rows) or any(not row.get('id') or type(row.get('supported')) is not bool or type(row.get('score')) not in (int,float) or not math.isfinite(row['score']) for row in rows):raise ValueError('Invalid/duplicate labels')
    # Keep every pair from a query in one partition. Pair-level splitting
    # would leak the same query between fit and holdout and overstate quality.
    groups={}
    for row in rows:groups.setdefault(row.get('queryId') or row['id'],[]).append(row)
    ordered=sorted(groups,key=lambda group:hashlib.sha256(f"{seed}:{group}".encode()).hexdigest())
    split=int(len(ordered)*.7)
    train=[row for group in ordered[:split] for row in sorted(groups[group],key=lambda row:row['id'])]
    validation=[row for group in ordered[split:] for row in sorted(groups[group],key=lambda row:row['id'])]
    if len(validation)<200 or any(len({row['supported'] for row in subset})<2 for subset in (train,validation)):raise ValueError('Need >=200 holdout labels and both classes in train/holdout')
    slope,intercept=fit(train)
    predictions=[(row,probability(row['score'],slope,intercept)) for row in validation]
    tp=sum(not row['supported'] and p<threshold for row,p in predictions)
    fp=sum(row['supported'] and p<threshold for row,p in predictions)
    fn=sum(not row['supported'] and p>=threshold for row,p in predictions)
    tn=len(validation)-tp-fp-fn
    def measure(hit,total):return {'value':hit/total if total else None,'count':total,'wilson95':wilson(hit,total)}
    canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    profile={'contract':'rerank-platt-v1',**{key:data[key] for key in ('model','revision','corpusHash') if data.get(key)},**{key:data[key] for key in ('route','routeHash') if data.get(key)},'validationSetHash':hashlib.sha256(canonical(validation)).hexdigest(),'sampleCount':len(validation),'slope':slope,'intercept':intercept,'trainingSetHash':hashlib.sha256(canonical(train)).hexdigest(),'trainingCount':len(train),'refusalThreshold':threshold,'thresholdSelection':{'method':'predeclared; holdout labels never tune threshold','threshold':threshold}}
    report={'method':'deterministic query-group-hash 70/30 disjoint split; regularized monotone Platt; predeclared threshold; Wilson intervals descriptive at pair level (pairs within queries correlated)','seed':seed,'threshold':threshold,'trainingCount':len(train),'holdoutCount':len(validation),'trainingQueries':len(ordered[:split]),'holdoutQueries':len(ordered[split:]),'refusalPrecision':measure(tp,tp+fp),'refusalRecall':measure(tp,tp+fn),'answerPrecision':measure(tn,tn+fn),'answerRecall':measure(tn,tn+fp),'brier':sum((p-int(row['supported']))**2 for row,p in predictions)/len(validation),'confusion':{'refusalCorrect':tp,'refusalIncorrect':fp,'answerUnsupported':fn,'answerSupported':tn},'validationSetHash':profile['validationSetHash']}
    clusters={}
    for row,p in predictions:
        key=row.get('queryId') or row['id'];counts=clusters.setdefault(key,[0,0,0,0])
        index=0 if not row['supported'] and p<threshold else 1 if row['supported'] and p<threshold else 2 if not row['supported'] else 3
        counts[index]+=1
    rng=random.Random(seed);values=list(clusters.values());samples={key:[] for key in ('refusalPrecision','refusalRecall','answerPrecision','answerRecall')}
    for _ in range(2000):
        drawn=[rng.choice(values) for _ in values];a,b,c,d=[sum(row[i] for row in drawn) for i in range(4)]
        for key,hit,total in [('refusalPrecision',a,a+b),('refusalRecall',a,a+c),('answerPrecision',d,d+c),('answerRecall',d,d+b)]:
            if total:samples[key].append(hit/total)
    for key,values in samples.items():
        ordered_values=sorted(values)
        def percentile(q):
            position=(len(ordered_values)-1)*q;low=math.floor(position);high=math.ceil(position)
            return ordered_values[low]+(ordered_values[high]-ordered_values[low])*(position-low)
        report[key]['queryClusterBootstrap95']=[percentile(.025),percentile(.975)] if len(values)>=1900 else None
    report['intervalMethod']='2000 resamples of holdout query clusters; percentile 95%; pair Wilson intervals descriptive only'
    report['target']=data.get('labelPolicy','labeled support pairs; query-level refusal requires answerability judgments')
    report['deploymentEligible']=bool(isinstance(data.get('revision'),str) and data['revision'].strip())
    if not report['deploymentEligible']:report['deploymentBlocker']='Missing immutable reranker deployment revision; diagnostics cannot activate a profile'
    return profile,report


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--labels',required=True);parser.add_argument('--profile');parser.add_argument('--report',required=True);parser.add_argument('--seed',default='20261007');parser.add_argument('--threshold',type=float,default=.95);parser.add_argument('--diagnostic-only',action='store_true',help='holdout metrics only; never write a runtime profile, even if deployment revision is unknown')
    args=parser.parse_args()
    if not 0<args.threshold<1:parser.error('Threshold must be between zero and one')
    if not args.diagnostic_only and not args.profile:parser.error('--profile required unless --diagnostic-only')
    profile,report=calibrate(json.loads(Path(args.labels).read_text()),args.seed,args.threshold,args.diagnostic_only)
    if not args.diagnostic_only:Path(args.profile).write_text(json.dumps(profile,indent=2)+'\n')
    Path(args.report).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'trainingCount':report['trainingCount'],'holdoutCount':report['holdoutCount'],'refusalPrecision':report['refusalPrecision'],'refusalRecall':report['refusalRecall']}))
