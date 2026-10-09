"""Bounded image frames and overlapping long-screenshot tiles (no downloads)."""
from __future__ import annotations
from typing import TYPE_CHECKING
import io
from pathlib import Path

if TYPE_CHECKING or __package__:
    from .env_config import env_int
else:
    from env_config import env_int

MAX_PIXELS = env_int('PARSER_IMAGE_MAX_PIXELS', 80_000_000)
MAX_TOTAL_PIXELS = env_int('PARSER_IMAGE_TOTAL_PIXELS', 200_000_000)
MAX_FRAMES = env_int('PARSER_IMAGE_MAX_FRAMES', 200)
TILE_HEIGHT = env_int('PARSER_IMAGE_TILE_HEIGHT', 2000)
TILE_OVERLAP = min(256, TILE_HEIGHT // 4)
MAX_TILES = env_int('PARSER_IMAGE_MAX_TILES', 500)
WORKING_PIXELS = env_int('PARSER_IMAGE_WORKING_PIXELS', 8_000_000)


def prepare(path: Path, unit_ids=None):
    from PIL import Image, ImageOps, ImageFilter, ImageStat
    parts, units = [], []
    with Image.open(path) as source:
        frames = getattr(source, 'n_frames', 1)
        if frames > MAX_FRAMES:
            raise ValueError('Image exceeds frame budget')
        total = 0
        for page in range(1, frames + 1):
            identifier = f'image:frame:{page}'
            if unit_ids and identifier not in unit_ids and not any(u.startswith(identifier + ':') for u in unit_ids):
                units.append({'id': identifier, 'kind': 'frame', 'page': page, 'status': 'skipped',
                              'native_text_chars': 0, 'generated_text_chars': 0})
                continue
            source.seek(page - 1)
            width, height = source.size
            if width * height > MAX_PIXELS:
                raise ValueError('Image exceeds decoded pixel budget')
            total += width * height
            if total > MAX_TOTAL_PIXELS:
                raise ValueError('Image exceeds total frame pixel budget')
            frame = ImageOps.exif_transpose(source).convert('RGB')
            metric = frame.copy()
            metric.thumbnail((256, 256))
            focus_variance = ImageStat.Stat(metric.convert('L').filter(ImageFilter.FIND_EDGES)).var[0]
            # Very tall screenshots stay at readable resolution: crop first,
            # then scale each tile. The overlap is declared, and OCR line reuse
            # is handled in the caller rather than duplicating facts silently.
            tall = frame.height > TILE_HEIGHT * 2 and frame.height > frame.width * 3
            starts = range(0, frame.height, TILE_HEIGHT - TILE_OVERLAP) if tall else [0]
            for tile, top in enumerate(starts, 1):
                key = f'{identifier}:tile:{tile}'
                if unit_ids and identifier not in unit_ids and key not in unit_ids:
                    units.append({'id': key, 'kind': 'image', 'page': page, 'status': 'skipped',
                                  'native_text_chars': 0, 'generated_text_chars': 0})
                    continue
                bottom = min(top + TILE_HEIGHT, frame.height) if tall else frame.height
                crop = frame.crop((0, top, frame.width, bottom))
                if crop.width * crop.height > WORKING_PIXELS:
                    scale = (WORKING_PIXELS / (crop.width * crop.height)) ** .5
                    crop = crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))))
                buf = io.BytesIO()
                crop.save(buf, 'PNG')
                parts.append({'key': key, 'ext': 'png', 'blob': buf.getvalue(), 'page': page,
                              'anchor': identifier, 'bbox': [0, top, frame.width, bottom - top],
                              'standalone': True, 'coordinate_space': 'source-pixel', 'bbox_format': 'xywh', 'overlap_pixels': TILE_OVERLAP if tall else 0,
                              'focus_variance': round(focus_variance, 2)})
                if len(parts) > MAX_TILES:
                    raise ValueError('Image exceeds tile budget')
                if bottom == frame.height:
                    break
    return parts, units
