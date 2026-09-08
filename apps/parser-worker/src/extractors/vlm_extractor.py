"""VLM (Vision Language Model) extractor for charts, diagrams, and visual elements.

Uses an OpenAI-compatible vision API to generate text descriptions of visual content
that traditional OCR cannot understand (charts, flowcharts, architecture diagrams, etc.).
"""
from __future__ import annotations

import base64
import logging
import os
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


async def enrich_markdown_with_vlm(
    markdown: str,
    source_path: Path | str,
    *,
    context_hint: str = '',
) -> tuple[str, dict[str, Any]]:
    """Scan markdown for image placeholders and enrich them with VLM descriptions.
    
    Looks for patterns like:
    - <!-- image --> or <!-- picture --> or <!-- figure -->
    - ![alt](path)
    
    For each found image reference, if the image file exists, describe it with VLM
    and insert the description.
    
    Returns:
        Tuple of (enriched_markdown, metadata_dict)
    """
    if not is_vlm_available():
        return markdown, {'vlm_enabled': False}
    
    import re
    
    vlm_stats = {
        'vlm_enabled': True,
        'vlm_model': VLM_MODEL,
        'vlm_placeholders_found': 0,
        'vlm_descriptions_added': 0,
        'vlm_errors': 0,
    }
    
    # Find image placeholders
    placeholder_pattern = re.compile(
        r'<!--\s*(?:image|picture|figure)(?:\s+[^>]*)??\s*-->',
        re.IGNORECASE,
    )
    
    placeholders = list(placeholder_pattern.finditer(markdown))
    vlm_stats['vlm_placeholders_found'] = len(placeholders)
    
    if not placeholders:
        return markdown, vlm_stats
    
    logger.info('Found %d image placeholders to enrich with VLM', len(placeholders))
    
    # Process placeholders in reverse order to preserve offsets
    for match in reversed(placeholders):
        try:
            description = await describe_image_with_vlm(
                Path(source_path),
                context_hint=context_hint,
            )
            if description:
                # Insert description after the placeholder
                insertion = f'\n\n> **[图表描述 - VLM 自动生成]**\n>\n> {description}\n'
                markdown = markdown[:match.end()] + insertion + markdown[match.end():]
                vlm_stats['vlm_descriptions_added'] += 1
        except Exception as exc:
            logger.warning('VLM enrichment failed for placeholder at offset %d: %s', match.start(), exc)
            vlm_stats['vlm_errors'] += 1
    
    return markdown, vlm_stats
