import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from extractors import vlm_extractor


class PlaceholderHelperTests(unittest.TestCase):
    def test_resolves_existing_relative_image(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            image = root_path / "media" / "p1.png"
            image.parent.mkdir(parents=True, exist_ok=True)
            image.write_bytes(b"\x89PNG\r\n")
            doc = root_path / "doc.pdf"

            resolved = vlm_extractor._resolve_placeholder_image("<!-- image: media/p1.png -->", doc)

            self.assertEqual(resolved, image)

    def test_ignores_synthetic_identifiers_and_missing_files(self):
        with tempfile.TemporaryDirectory() as root:
            doc = Path(root) / "doc.pptx"
            self.assertIsNone(
                vlm_extractor._resolve_placeholder_image("<!-- image: slide-3-picture-2 -->", doc)
            )
            self.assertIsNone(
                vlm_extractor._resolve_placeholder_image("<!-- image: missing.png -->", doc)
            )
            self.assertIsNone(vlm_extractor._resolve_placeholder_image("<!-- image -->", doc))

    def test_page_index_prefers_explicit_token_then_heading(self):
        markdown = "## 第 1 页\n\ntext\n\n## 第 3 页\n\n"
        self.assertEqual(
            vlm_extractor._placeholder_page_index("<!-- image page 2 -->", markdown, len(markdown)),
            1,
        )
        # Nearest PRECEDING heading at end of document is 第 3 页 (0-indexed 2).
        self.assertEqual(
            vlm_extractor._placeholder_page_index("<!-- image -->", markdown, len(markdown)),
            2,
        )
        # Nothing preceding the first heading yet.
        self.assertEqual(
            vlm_extractor._placeholder_page_index("<!-- image -->", markdown, 0),
            None,
        )
        self.assertIsNone(
            vlm_extractor._placeholder_page_index("<!-- image -->", "no headings", 0)
        )


class EnrichMarkdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolvable_image_is_described(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            image = root_path / "p1.png"
            image.write_bytes(b"\x89PNG\r\n")
            markdown = "## 第 1 页\n\n<!-- image: p1.png -->\n"

            with patch.object(vlm_extractor, "is_vlm_available", return_value=True), patch.object(
                vlm_extractor, "describe_image_with_vlm", AsyncMock(return_value="图表描述")
            ):
                enriched, meta = await vlm_extractor.enrich_markdown_with_vlm(
                    markdown, root_path / "doc.pdf"
                )

            self.assertIn("图表描述", enriched)
            self.assertEqual(meta["vlm_descriptions_added"], 1)
            self.assertEqual(meta["vlm_errors"], 0)

    async def test_unresolvable_placeholder_is_skipped_without_name_error(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            markdown = "## 第 1 页\n\n<!-- image: slide-3-picture-2 -->\n"

            with patch.object(vlm_extractor, "is_vlm_available", return_value=True), patch.object(
                vlm_extractor, "describe_image_with_vlm", AsyncMock(return_value="不应调用")
            ):
                enriched, meta = await vlm_extractor.enrich_markdown_with_vlm(
                    markdown, root_path / "doc.pptx"
                )

            self.assertEqual(meta["vlm_descriptions_added"], 0)
            self.assertEqual(meta["vlm_placeholders_skipped"], 1)
            self.assertEqual(meta["vlm_errors"], 0)
            self.assertNotIn("不应调用", enriched)

    async def test_pdf_placeholder_uses_nearest_page(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            markdown = "## 第 1 页\n\n正文\n\n## 第 2 页\n\n<!-- image -->\n"

            with patch.object(vlm_extractor, "is_vlm_available", return_value=True), patch.object(
                vlm_extractor, "describe_pdf_page_with_vlm", AsyncMock(return_value="第二页图表")
            ) as describe_page:
                enriched, meta = await vlm_extractor.enrich_markdown_with_vlm(
                    markdown, root_path / "doc.pdf"
                )

            self.assertEqual(describe_page.await_count, 1)
            self.assertEqual(describe_page.await_args.args[1], 1)
            self.assertIn("第二页图表", enriched)


if __name__ == "__main__":
    unittest.main()
