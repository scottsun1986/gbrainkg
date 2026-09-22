"""VLM (Vision Language Model) extractor for charts, diagrams, and visual elements.

Uses an OpenAI-compatible vision API to generate text descriptions of visual content
that traditional OCR cannot understand (charts, flowcharts, architecture diagrams, etc.).
"""
from __future__ import annotations

import base64
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger('parser-worker.vlm')

# Configuration via environment variables
VLM_ENABLED = os.environ.get('VLM_ENABLED', '1').lower() not in {'0', 'false', 'no'}
VLM_BASE_URL = os.environ.get('VLM_BASE_URL', '').rstrip('/')
VLM_API_KEY = os.environ.get('VLM_API_KEY', '')
VLM_MODEL = os.environ.get('VLM_MODEL', 'qwen2-vl-7b-instruct')
VLM_TIMEOUT_SECONDS = float(os.environ.get('VLM_TIMEOUT_SECONDS', '30'))
VLM_MAX_TOKENS = int(os.environ.get('VLM_MAX_TOKENS', '500'))


def is_vlm_available() -> bool:
    """Check if VLM is configured and available."""
    return VLM_ENABLED and bool(VLM_BASE_URL) and bool(VLM_API_KEY)


async def describe_image_with_vlm(
    image_path: Path | str,
    *,
    context_hint: str = '',
    timeout: float | None = None,
) -> str:
    """Use a VLM to generate a text description of an image.
    
    Args:
        image_path: Path to the image file (PNG, JPG, etc.)
        context_hint: Optional hint about what kind of document this image is from
        timeout: Override default timeout
    
    Returns:
        A markdown text description of the visual content.
        Returns empty string if VLM is unavailable or call fails.
    """
    if not is_vlm_available():
        logger.debug('VLM is not configured, skipping image description')
        return ''
    
    image_path = Path(image_path)
    if not image_path.exists():
        logger.warning('Image file not found: %s', image_path)
        return ''
    
    # Read and encode image
    image_bytes = image_path.read_bytes()
    if len(image_bytes) > 20 * 1024 * 1024:  # 20MB limit
        logger.warning('Image too large for VLM processing: %d bytes', len(image_bytes))
        return ''
    
    # Determine MIME type
    suffix = image_path.suffix.lower()
    mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', 
                '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'}
    mime_type = mime_map.get(suffix, 'image/png')
    
    base64_image = base64.b64encode(image_bytes).decode('utf-8')
    
    system_prompt = '''你是一个专业的文档分析助手。请分析图片中的视觉内容并生成结构化的文本描述。

分析要求：
1. 如果是**图表**（柱状图/饼图/折线图/散点图等）：提取标题、坐标轴含义、所有数据点/数值、趋势和结论
2. 如果是**流程图/架构图**：描述所有节点、连接关系和流向
3. 如果是**表格**：转换为标准 Markdown 表格格式
4. 如果是**其他图片**：描述关键视觉内容

输出格式要求：
- 使用中文
- 使用 Markdown 格式
- 数据必须精确，不要编造数字
- 如果无法清晰识别某个数值，标注"(不清晰)"'''
    
    if context_hint:
        system_prompt += f'\n\n该图片来自以下文档：{context_hint}'
    
    try:
        async with httpx.AsyncClient(timeout=timeout or VLM_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f'{VLM_BASE_URL}/chat/completions',
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {VLM_API_KEY}',
                },
                json={
                    'model': VLM_MODEL,
                    'messages': [
                        {'role': 'system', 'content': system_prompt},
                        {
                            'role': 'user',
                            'content': [
                                {'type': 'text', 'text': '请分析以下图片并生成结构化文本描述：'},
                                {
                                    'type': 'image_url',
                                    'image_url': {
                                        'url': f'data:{mime_type};base64,{base64_image}',
                                    },
                                },
                            ],
                        },
                    ],
                    'temperature': 0,
                    'max_tokens': VLM_MAX_TOKENS,
                },
            )
            response.raise_for_status()
            data = response.json()
            description = data.get('choices', [{}])[0].get('message', {}).get('content', '').strip()
            if description:
                logger.info('VLM described image %s: %d chars', image_path.name, len(description))
            return description
    except Exception as exc:
        logger.warning('VLM image description failed for %s: %s', image_path.name, exc)
        return ''


async def describe_pdf_page_with_vlm(
    pdf_path: Path | str,
    page_number: int,
    *,
    context_hint: str = '',
    dpi: int = 200,
) -> str:
    """Render a specific PDF page to image and describe it with VLM.
    
    Args:
        pdf_path: Path to the PDF file
        page_number: 0-indexed page number
        context_hint: Document title or context hint
        dpi: Resolution for PDF rendering
    
    Returns:
        Text description of the page's visual content.
    """
    if not is_vlm_available():
        return ''
    
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning('PyMuPDF not available for PDF page rendering')
        return ''
    
    pdf_path = Path(pdf_path)
    try:
        doc = fitz.open(str(pdf_path))
        if page_number >= len(doc):
            doc.close()
            return ''
        
        page = doc[page_number]
        # Render page to PNG image
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat)
        
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            pix.save(tmp.name)
            tmp_path = Path(tmp.name)
        
        doc.close()
        
        try:
            description = await describe_image_with_vlm(
                tmp_path,
                context_hint=f'{context_hint} - 第{page_number + 1}页' if context_hint else f'第{page_number + 1}页',
            )
            return description
        finally:
            tmp_path.unlink(missing_ok=True)
    except Exception as exc:
        logger.warning('Failed to render/describe PDF page %d: %s', page_number, exc)
        return ''


_IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'}

# ``## 第 N 页`` / ``## Page N`` page markers emitted by the PDF/PPTX pipelines.
_PAGE_HEADING_RE = re.compile(
    r'^##\s*(?:第\s*)?(\d+)\s*(?:页|page)\s*$',
    re.IGNORECASE | re.MULTILINE,
)
# Explicit page reference inside a placeholder comment (e.g. ``<!-- image: p3.png page 3 -->``).
_PLACEHOLDER_PAGE_RE = re.compile(r'(?:第\s*(\d+)\s*页)|(?:page\s*[:#]?\s*(\d+))', re.IGNORECASE)
# ``image[|picture|figure]`` followed by an optional ``:`` and an inline resource token.
_PLACEHOLDER_TOKEN_RE = re.compile(
    r'(image|picture|figure)\b\s*:?\s*(.*)$',
    re.IGNORECASE,
)


def _resolve_placeholder_image(comment_text: str, source_path: Path | str) -> Path | None:
    """Resolve a real image file referenced by an image placeholder comment.

    Only tokens that carry a recognised image extension are considered, and the
    file must actually exist. This deliberately rejects synthetic identifiers
    such as ``slide-3-picture-2`` so the raw source document is never mistaken
    for an image (see ``enrich_markdown_with_vlm``).
    """
    inner = re.sub(r'^\s*<!--|-->\s*$', '', (comment_text or '').strip()).strip()
    if not inner:
        return None
    match = _PLACEHOLDER_TOKEN_RE.match(inner)
    token = (match.group(2) if match else inner).strip().strip('"\'')
    if not token:
        return None
    candidate = Path(token)
    if candidate.suffix.lower() not in _IMAGE_SUFFIXES:
        return None
    source_path = Path(source_path)
    candidates = [candidate] if candidate.is_absolute() else [source_path.parent / candidate, candidate]
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def _placeholder_page_index(comment_text: str, markdown: str, offset: int) -> int | None:
    """Return the 0-indexed page for a placeholder, or None if it cannot be determined.

    Priority: an explicit ``第 N 页`` / ``page N`` token inside the placeholder
    comment, then the nearest preceding ``## 第 N 页`` heading in the markdown.
    """
    explicit = _PLACEHOLDER_PAGE_RE.search(comment_text or '')
    if explicit:
        raw = explicit.group(1) or explicit.group(2)
        if raw and raw.isdigit():
            return max(0, int(raw) - 1)
    preceding = list(_PAGE_HEADING_RE.finditer(markdown, 0, max(0, offset)))
    if preceding:
        raw = preceding[-1].group(1)
        if raw.isdigit():
            return max(0, int(raw) - 1)
    return None


async def enrich_markdown_with_vlm(
    markdown: str,
    source_path: Path | str,
    *,
    context_hint: str = '',
) -> tuple[str, dict[str, Any]]:
    """Scan markdown for image placeholders and enrich them with VLM descriptions.

    Looks for patterns like:
    - <!-- image --> or <!-- picture --> or <!-- figure -->
    - (optionally carrying a real media path, e.g. <!-- image: media/p1.png -->)

    The VLM must only ever receive a real image resource. For every
    placeholder we try, in order:
    1. A path-like token inside the placeholder comment that resolves to an
       existing image file (absolute, or relative to the source directory).
    2. The source file itself, but ONLY when it is a standalone image upload.
    3. For PDF sources, the page containing the placeholder (explicit page
       token in the comment, or the nearest preceding ``## 第 N 页`` heading),
       rendered to an image via describe_pdf_page_with_vlm.
    If none of these yields an image, the placeholder is skipped with a
    warning. The raw source document (pptx/docx/pdf bytes) is never sent to
    the VLM as if it were an image.

    Returns:
        Tuple of (enriched_markdown, metadata_dict)
    """
    if not is_vlm_available():
        return markdown, {'vlm_enabled': False}

    # Annotate as dict[str, Any] so the int counters can be incremented below
    # (a bare dict would widen to dict[str, object] and reject `+= 1`).
    vlm_stats: dict[str, Any] = {
        'vlm_enabled': True,
        'vlm_model': VLM_MODEL,
        'vlm_placeholders_found': 0,
        'vlm_descriptions_added': 0,
        'vlm_placeholders_skipped': 0,
        'vlm_errors': 0,
    }

    # Find image placeholders. Must also match the colon form emitted by the
    # PPTX/Docling pipelines (`<!-- image: media/p1.png -->`); the previous
    # pattern required whitespace right after the keyword, so every colon-form
    # placeholder silently skipped VLM enrichment.
    placeholder_pattern = re.compile(
        r'<!--\s*(?:image|picture|figure)\b[^>]*?-->',
        re.IGNORECASE,
    )

    placeholders = list(placeholder_pattern.finditer(markdown))
    vlm_stats['vlm_placeholders_found'] = len(placeholders)

    if not placeholders:
        return markdown, vlm_stats

    logger.info('Found %d image placeholders to enrich with VLM', len(placeholders))

    source_path = Path(source_path)
    source_suffix = source_path.suffix.lower()
    source_is_image = source_suffix in _IMAGE_SUFFIXES

    # Process placeholders in reverse order to preserve offsets
    for match in reversed(placeholders):
        comment_text = match.group(0)
        try:
            image_path = _resolve_placeholder_image(comment_text, source_path)
            if image_path is None and source_is_image:
                # Standalone image upload: the source file IS the real image.
                image_path = source_path

            if image_path is not None:
                description = await describe_image_with_vlm(
                    image_path,
                    context_hint=context_hint,
                )
            elif source_suffix == '.pdf':
                page_index = _placeholder_page_index(comment_text, markdown, match.start())
                if page_index is None:
                    logger.warning(
                        'Skipping VLM enrichment for placeholder at offset %d in %s: '
                        'page position could not be determined',
                        match.start(), source_path.name,
                    )
                    vlm_stats['vlm_placeholders_skipped'] += 1
                    continue
                description = await describe_pdf_page_with_vlm(
                    source_path,
                    page_index,
                    context_hint=context_hint,
                )
            else:
                logger.warning(
                    'Skipping VLM enrichment for placeholder at offset %d in %s: '
                    'no real image resource could be resolved for this placeholder '
                    '(the source document itself is never sent to the VLM)',
                    match.start(), source_path.name,
                )
                vlm_stats['vlm_placeholders_skipped'] += 1
                continue

            if description:
                # Insert description after the placeholder
                insertion = f'\n\n> **[图表描述 - VLM 自动生成]**\n>\n> {description}\n'
                markdown = markdown[:match.end()] + insertion + markdown[match.end():]
                vlm_stats['vlm_descriptions_added'] += 1
            else:
                logger.warning(
                    'VLM returned no description for placeholder at offset %d in %s',
                    match.start(), source_path.name,
                )
        except Exception as exc:
            logger.warning('VLM enrichment failed for placeholder at offset %d: %s', match.start(), exc)
            vlm_stats['vlm_errors'] += 1

    return markdown, vlm_stats
