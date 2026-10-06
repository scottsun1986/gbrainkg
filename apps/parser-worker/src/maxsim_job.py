"""Bounded CPU MaxSim kernel. Executed in a killable subprocess in the shared worker."""
import json
import os
import sys
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import numpy as np

def validate_vectors(vectors, dimensions=None):
    if not isinstance(vectors, list) or not 1 <= len(vectors) <= 128:
        raise ValueError('Invalid token vector count')
    width = dimensions if dimensions is not None else len(vectors[0]) if isinstance(vectors[0], list) else 0
    if not 1 <= width <= 1024 or any(not isinstance(row, list) or len(row) != width for row in vectors):
        raise ValueError('Invalid token vector dimensions')
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) for row in vectors for value in row):
        raise ValueError('Invalid token vector values')
    return width


def maxsim(query, documents):
    width = validate_vectors(query)
    q = np.asarray(query, dtype=np.float32)
    if q.ndim != 2 or not 1 <= q.shape[0] <= 128 or not 1 <= q.shape[1] <= 1024 or not np.isfinite(q).all():
        raise ValueError('Invalid query token vectors')
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    if not 1 <= len(documents) <= 40:
        raise ValueError('Candidate budget exceeded')
    scores = []
    for row in documents:
        validate_vectors(row['vectors'], width)
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
