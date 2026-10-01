"""Bounded CPU MaxSim kernel. Executed in a killable subprocess in the shared worker."""
import json
import os
import sys
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import numpy as np

def maxsim(query, documents):
    q = np.asarray(query, dtype=np.float32)
    if q.ndim != 2 or not 1 <= q.shape[0] <= 128 or not 1 <= q.shape[1] <= 1024 or not np.isfinite(q).all():
        raise ValueError('Invalid query token vectors')
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    if not 1 <= len(documents) <= 40:
        raise ValueError('Candidate budget exceeded')
    scores = []
    for row in documents:
        d = np.asarray(row['vectors'], dtype=np.float32)
        if d.ndim != 2 or not 1 <= d.shape[0] <= 128 or d.shape[1] != q.shape[1] or not np.isfinite(d).all():
            raise ValueError('Invalid document token vectors')
        d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-12)
        scores.append({'id': row['id'], 'score': float(np.max(q @ d.T, axis=1).mean())})
    return scores

if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as source:
        data = json.load(source)
    result = {'contract': 'cosine-maxsim-mean-v1', 'scores': maxsim(data['query'], data['documents'])}
    with open(sys.argv[2], 'w', encoding='utf-8') as target:
        json.dump(result, target, allow_nan=False)
