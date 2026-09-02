import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from main import assess_content_quality, classify_pdf  # noqa: E402


class ParserQualityTests(unittest.TestCase):
    def test_plain_text_passes_quality_gate(self):
        result = assess_content_quality(
            "企业研发管理规范\n第一条 适用于研发项目全生命周期管理。",
            ".txt",
            {},
        )
        self.assertEqual(result["quality_status"], "passed")
        self.assertEqual(result["quality_issues"], [])

    def test_image_placeholder_is_not_indexable(self):
        result = assess_content_quality("<!-- image -->", ".pptx", {})
        self.assertEqual(result["quality_status"], "rejected")
        self.assertIn("OCR", " ".join(result["quality_issues"]))

    def test_low_confidence_ocr_requires_review(self):
        result = assess_content_quality(
            "# 考勤制度\n工作时间为 09:00 至 18:00。",
            ".pdf",
            {"ocr_average_confidence": 0.61},
        )
        self.assertEqual(result["quality_status"], "needs_review")

    def test_pdf_classification_uses_page_coverage(self):
        self.assertEqual(classify_pdf(10, 10, 2_000, "good"), "text")
        self.assertEqual(classify_pdf(10, 0, 0, "empty"), "scanned")
        self.assertEqual(classify_pdf(10, 5, 400, "good"), "mixed")


if __name__ == "__main__":
    unittest.main()
