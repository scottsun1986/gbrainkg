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

    def test_list_and_code_boundaries_preserve_original_spacing(self):
        text = main.extract_plaintext('source.html', b'<ul><li>first</li><li>second</li></ul><pre>if x:\n    print(0)</pre>')
        self.assertIn('- first', text)
        self.assertIn('- second', text)
        self.assertIn('```\nif x:\n    print(0)\n```', text)

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


class EmbeddedImageFailureTests(unittest.TestCase):
    """Enumeration failure must never be reported as "this file has no images"."""

    def test_docx_extraction_failure_raises_instead_of_returning_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.docx"
            path.write_bytes(b"PK\x03\x04 truncated")

            def crashed(p, contract=None, unit_ids=None):
                """extract_docx records its failure instead of raising, so the
                lenient Docling fallback still works in the main parse path."""
                if contract is not None:
                    contract["error"] = "python-docx extraction failed: boom"
                return "", []

            with patch.object(main, "extract_docx", side_effect=crashed):
                with self.assertRaises(RuntimeError):
                    main.extract_embedded_image_parts(path)

    def test_docx_records_failure_so_the_caller_can_distinguish_empty_from_crashed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.docx"
            path.write_bytes(b"PK\x03\x04 truncated")
            contract: dict = {}
            markdown, images = main.extract_docx(path, contract)
            self.assertEqual((markdown, images), ("", []))
            self.assertIn("error", contract)

    def test_pdf_image_enumeration_failure_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.pdf"
            path.write_bytes(b"%PDF-1.4 truncated")
            with patch("pypdf.PdfReader", side_effect=OSError("unreadable")):
                # The lenient helper stays lenient: the PyMuPDF-less PDF region
                # path uses it as a fallback and only needs the recovered rows.
                self.assertEqual(main.extract_pdf_page_images(path), [])
                # The strict wrapper used by OCR enrichment must raise instead.
                with self.assertRaises(RuntimeError):
                    main.enumerate_pdf_images(path)

    def test_unsupported_suffix_reports_no_images_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "notes.txt"
            path.write_bytes(b"plain text has no embedded images")
            self.assertEqual(main.extract_embedded_image_parts(path), [])


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
