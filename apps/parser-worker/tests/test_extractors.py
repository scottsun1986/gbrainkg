import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import main


class HtmlExtractionTests(unittest.TestCase):
    def test_table_cells_stay_separated(self):
        html = (
            "<html><body><table>"
            "<tr><th>部门</th><th>指标</th></tr>"
            "<tr><td>研发</td><td>120</td></tr>"
            "</table></body></html>"
        )
        text = main.extract_plaintext("sheet.html", html.encode("utf-8"))

        # The old regex flattened <td> boundaries, so "研发120" was one token.
        self.assertIn("部门 | 指标", text)
        self.assertIn("研发 | 120", text)
        self.assertNotIn("<", text)

    def test_script_and_style_bodies_are_dropped(self):
        html = (
            "<html><head><style>body{color:red}</style></head>"
            "<body><script>alert('x')</script><p>正文内容</p></body></html>"
        )
        text = main.extract_plaintext("page.html", html.encode("utf-8"))

        self.assertIn("正文内容", text)
        self.assertNotIn("alert", text)
        self.assertNotIn("color:red", text)

    def test_headings_keep_markdown_form(self):
        html = "<html><body><h1>总则</h1><h2>适用范围</h2><p>本公司员工适用。</p></body></html>"
        text = main.extract_plaintext("rules.html", html.encode("utf-8"))

        self.assertIn("# 总则", text)
        self.assertIn("## 适用范围", text)

    def test_malformed_markup_falls_back_to_tag_stripping(self):
        html = "<html><body><p>未闭合段落<b>加粗</body></html>"
        text = main.extract_plaintext("broken.html", html.encode("utf-8"))
        self.assertTrue(text.strip())
        self.assertNotIn("<", text)


class LegacyWordGuardTests(unittest.TestCase):
    def test_rejects_files_that_are_not_ole2_documents(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fake.doc"
            path.write_bytes(b"PK\x03\x04 this is really a docx/zip renamed to .doc")
            with self.assertRaises(RuntimeError) as error:
                main.extract_legacy_word(path)
            self.assertIn("not an OLE2 compound document", str(error.exception))

    def test_rejects_oversized_documents_before_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "big.doc"
            path.write_bytes(bytes.fromhex("D0CF11E0A1B11AE1") + b"x" * 32)
            with patch.object(main, "LEGACY_WORD_MAX_BYTES", 8):
                with self.assertRaises(RuntimeError) as error:
                    main.extract_legacy_word(path)
            self.assertIn("conversion limit", str(error.exception))


class HealthCapabilityTests(unittest.TestCase):
    def test_health_reports_effective_not_requested_capabilities(self):
        health = main.health_check()

        # The production image has neither docling nor PyMuPDF: the health probe
        # must not advertise a capability that silently fails.
        self.assertEqual(
            health["local_docling_enabled"],
            main.LOCAL_DOCLING_ENABLED and main.DOCLING_INSTALLED,
        )
        self.assertIn("docling_installed", health)
        self.assertIn("pymupdf_installed", health)
        self.assertIn("page_vlm_enrichment_available", health)
