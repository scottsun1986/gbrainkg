"""Observable source coverage, actual text counts and image provenance."""
from __future__ import annotations
import base64
import hashlib
import mimetypes
import re
from typing import Any
from contextvars import ContextVar

try:
    from src import artifact_store
except ImportError:
    import artifact_store


inline_asset_bytes: ContextVar[int] = ContextVar('inline_asset_bytes', default=0)
asset_artifacts: ContextVar[dict | None] = ContextVar('asset_artifacts', default=None)
MAX_INLINE_ASSET_BYTES = 4 * 1024 * 1024


def text_chars(text: str) -> int:
    text = re.sub(r'<!--.*?-->', '', str(text or ''), flags=re.S)
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    return len(re.sub(r'\s', '', text))


def body_text(markdown: str) -> str:
    """Remove parser scaffolding; do not turn a title or error note into facts."""
    text = re.sub(r'<!--.*?-->', '', str(markdown or ''), flags=re.S)
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    lines = []
    for line in text.splitlines():
        if re.match(r'^\s*(?:#\s|##\s*(?:第\s*\d+\s*页|Page\s*\d+)|###\s*(?:图片文字|图片区域|视觉内容解析|工作表：)|\*\(.*\)\*\s*$)', line):
            continue
        if re.fullmatch(r'[\s|:\-]+', line):
            continue
        lines.append(line)
    return '\n'.join(lines).strip()


def unit(identifier, kind, text='', **location):
    count = text_chars(body_text(text))
    return {'id': identifier, 'kind': kind, 'status': 'processed' if count else 'failed',
            'native_text_chars': count, 'generated_text_chars': 0, **location}


def asset(image: dict[str, Any], identity: str) -> dict[str, Any]:
    blob = bytes(image.get('blob') or b'')
    if not blob and image.get('blob_path'):
        from pathlib import Path
        blob = Path(image['blob_path']).read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    extension = str(image.get('ext') or 'png').lower().lstrip('.')
    result = {'id': str(image.get('key') or f'asset-{digest[:16]}'), 'sha256': digest,
              'mime': mimetypes.guess_type('image.' + extension)[0] or 'application/octet-stream',
              'filename': f'{digest}.{extension}', 'status': image.get('status', 'pending')}
    for key in ('page', 'slide', 'shape', 'anchor', 'bbox', 'text', 'error', 'source_kind', 'focus_variance', 'overlap_pixels', 'coordinate_space', 'bbox_format'):
        if key in image:
            result[key] = image[key]
    if 'page_index' in image:
        result['page'] = image['page_index'] + 1
    if blob:
        size = ((len(blob) + 2) // 3) * 4
        if len(blob) <= 256 * 1024 and inline_asset_bytes.get() + size <= MAX_INLINE_ASSET_BYTES:
            result['data_base64'] = base64.b64encode(blob).decode('ascii')
            inline_asset_bytes.set(inline_asset_bytes.get() + size)
        else:
            reusable = asset_artifacts.get()
            if reusable is None:
                reusable = {}
                asset_artifacts.set(reusable)
            if digest not in reusable:
                reusable[digest] = artifact_store.publish_blob(blob, identity, result['mime'])
            result['artifact_id'] = reusable[digest]
    return result


def summarize(task: dict[str, Any]):
    units = task.get('source_units') or []
    task['coverage'] = {'total': len(units), 'processed': sum(u['status'] == 'processed' for u in units),
                        'failed': sum(u['status'] == 'failed' for u in units),
                        'skipped': sum(u['status'] == 'skipped' for u in units)}
    if 'native_text_chars' not in task:
        task['native_text_chars'] = sum(u.get('native_text_chars', 0) for u in units)
    task.setdefault('generated_text_chars', sum(u.get('generated_text_chars', 0) for u in units))
    task['content_text_chars'] = task['native_text_chars'] + task['generated_text_chars']


def attach_offsets(task: dict[str, Any]):
    markdown = task.get('markdown', '')
    cursor = 0
    for item in task.get('source_units', []):
        if item.get('reference_only'):
            continue
        projection = item.get('markdown', '')
        if projection:
            start = markdown.find(projection, cursor)
            if start < 0:
                start = markdown.find(projection)
            if start >= 0:
                item.update(char_start=start, char_end=start + len(projection))
                cursor = start + len(projection)
