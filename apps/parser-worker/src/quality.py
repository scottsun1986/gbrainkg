from __future__ import annotations

import re
from typing import Any


def _pdf_native_quality(text: str) -> str:
    if not text:
        return "empty"
    replacement_ratio = text.count("\ufffd") / max(len(text), 1)
    control_count = sum(1 for char in text if ord(char) < 32 and char not in "\n\r\t")
    control_ratio = control_count / max(len(text), 1)
    return "poor" if replacement_ratio > 0.08 or control_ratio > 0.02 else "good"


def classify_pdf(
    page_count: int, text_pages: int, native_chars: int, native_quality: str
) -> str:
    """Classify a PDF from page coverage, not just total extracted length."""
    page_ratio = text_pages / max(page_count, 1)
    average_chars = native_chars / max(page_count, 1)
    if (
        native_quality == "good"
        and native_chars >= 80
        and (page_count == 1 or page_ratio >= 0.65)
        and average_chars >= 80
    ):
        return "text"
    if page_ratio <= 0.20 or (native_chars < 40 and native_quality != "good"):
        return "scanned"
    return "mixed"


def assess_content_quality(markdown: str, suffix: str, task: dict[str, Any]) -> dict[str, Any]:
    """Return a conservative quality signal before a document is published.

    The parser may produce non-empty but unusable output (font encoding
    damage, a blank image, or a PPTX with only unrecognised shapes). Quality is
    therefore persisted separately from parser success. A review result keeps
    the Markdown/chunks available for inspection but never enters GBrain.
    """
    text = str(markdown or "")
    placeholder_count = len(re.findall(r"<!--\s*(?:image|picture|figure)(?:[^\n>]*)\s*-->", text, flags=re.IGNORECASE))
    quality_text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    quality_text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", quality_text)
    meaningful = re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", quality_text)
    meaningful_count = len(meaningful)
    replacement_count = text.count("\ufffd")
    control_count = sum(1 for char in text if ord(char) < 32 and char not in "\n\r\t")
    replacement_ratio = replacement_count / max(len(text), 1)
    control_ratio = control_count / max(len(text), 1)
    issues: list[str] = []
    binary_input = suffix not in {".md", ".txt", ".csv", ".html", ".htm"}
    if meaningful_count == 0:
        issues.append("没有提取到可检索文字")
    if binary_input and meaningful_count < 20:
        issues.append("提取文字过少，可能是空白文件或解析不完整")
    if replacement_ratio > 0.01:
        issues.append("存在较多字体编码替换字符")
    if control_ratio > 0.02:
        issues.append("存在异常控制字符")
    if placeholder_count and suffix in {".pptx", ".png", ".jpg", ".jpeg"}:
        issues.append("版面解析只返回图片占位符，图片文字尚未完成 OCR")
    confidence = task.get("ocr_average_confidence")
    if confidence is not None:
        try:
            if float(confidence) < 0.75:
                issues.append("OCR 平均置信度低于 0.75")
        except (TypeError, ValueError):
            pass
    if isinstance(task.get("quality_issues"), list):
        for issue in task["quality_issues"]:
            if isinstance(issue, str) and issue not in issues:
                issues.append(issue)
    score = 1.0
    score -= min(replacement_ratio * 4, 0.45)
    score -= min(control_ratio * 2, 0.2)
    if binary_input and meaningful_count < 20:
        score -= 0.45
    if confidence is not None:
        try:
            score = min(score, max(0.0, float(confidence)))
        except (TypeError, ValueError):
            pass
    score = round(max(0.0, min(1.0, score)), 4)
    status = "passed" if not issues else "needs_review"
    if meaningful_count == 0 or task.get("quality_status") == "rejected":
        status = "rejected"
    elif task.get("quality_status") == "needs_review":
        status = "needs_review"
    return {
        "quality_status": status,
        "quality_score": score,
        "quality_issues": issues,
        "quality_metrics": {
            "characters": len(text),
            "meaningful_characters": meaningful_count,
            "replacement_ratio": round(replacement_ratio, 6),
            "control_ratio": round(control_ratio, 6),
            "image_placeholders": placeholder_count,
        },
    }
