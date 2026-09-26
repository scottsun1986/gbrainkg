import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import main


class ExecuteContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_image_without_configured_extractor_fails_without_calling_baidu(self):
        png_bytes = bytes([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
        ])
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "LOCAL_DOCLING_ENABLED", False),
            patch.object(main, "OCR_PROVIDER", "none"),
            patch.object(main, "is_vlm_available", return_value=False),
            patch.object(main, "convert_image_with_baidu_ocr") as baidu,
        ):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post(
                    "/parse-execute",
                    files={"file": ("fixture.png", png_bytes, "image/png")},
                    data={"ocr_provider": "none"},
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result["status"], "failed")
            self.assertIn("requires configured OCR", result["error"])
            baidu.assert_not_called()

    async def test_execution_returns_result_without_durable_python_task(self):
        with tempfile.TemporaryDirectory() as root, patch.object(main, "UPLOAD_ROOT", Path(root)), patch.dict(os.environ, {"AUTH_TOKEN": "audit-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post('/parse-execute',
                    headers={"Authorization": "Bearer audit-token"},
                    files={"file": ("fixture.txt", "这是可检索的正常文档内容。".encode(), "text/plain")},
                    data={"ocr_api_key": "private-fixture-key"})
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result['status'], 'completed')
                self.assertIn('正常文档', result['markdown'])
                self.assertNotIn('private-fixture-key', response.text)
                self.assertNotIn(result['task_id'], main.tasks)
                self.assertEqual(list(Path(root).iterdir()), [])

    async def test_execution_requires_auth(self):
        with patch.dict(os.environ, {"AUTH_TOKEN": "audit-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post('/parse-execute', files={"file": ("fixture.txt", b"hello")})
                self.assertEqual(response.status_code, 401)

    async def test_execution_pptx_with_images_succeeds(self):
        import io
        from pptx import Presentation
        from pptx.util import Inches

        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        txBox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1))
        txBox.text_frame.text = "智慧城市架构规划方案"
        # 1x1 png image
        png_bytes = bytes([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82
        ])
        slide.shapes.add_picture(io.BytesIO(png_bytes), Inches(2), Inches(2), Inches(1), Inches(1))
        buf = io.BytesIO()
        prs.save(buf)
        pptx_content = buf.getvalue()

        with tempfile.TemporaryDirectory() as root, patch.object(main, "UPLOAD_ROOT", Path(root)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post(
                    '/parse-execute',
                    files={"file": ("smart_city.pptx", pptx_content, "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
                )
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result['status'], 'completed')
                self.assertIn("智慧城市架构规划方案", result['markdown'])
                self.assertIn("## 第 1 页", result['markdown'])

    async def test_execution_full_image_pptx_needs_review(self):
        import io
        from pptx import Presentation
        from pptx.util import Inches

        prs = Presentation()
        # Slide with only picture and no text frame
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        png_bytes = bytes([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82
        ])
        slide.shapes.add_picture(io.BytesIO(png_bytes), Inches(0), Inches(0), Inches(10), Inches(7.5))
        buf = io.BytesIO()
        prs.save(buf)
        pptx_content = buf.getvalue()

        with tempfile.TemporaryDirectory() as root, patch.object(main, "UPLOAD_ROOT", Path(root)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://parser") as client:
                response = await client.post(
                    '/parse-execute',
                    files={"file": ("full_image.pptx", pptx_content, "application/vnd.openxmlformats-officedocument.presentationml.presentation")},
                )
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertEqual(result['status'], 'completed')
                # Full-image PPTX without OCR text is no longer held for review.
                self.assertEqual(result['quality_status'], 'passed')
                self.assertIn("## 第 1 页", result['markdown'])

    def test_extract_excel_merged_cells_forward_fill(self):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "打分表"
        ws['A1'] = "部门"
        ws['B1'] = "团队"
        ws['C1'] = "得分"

        ws['A2'] = "软研中心"
        ws['B2'] = "团队Alpha"
        ws['C2'] = 90

        ws['A3'] = "软研中心"
        ws['B3'] = "团队Beta"
        ws['C3'] = 88
        ws.merge_cells("A2:A3")

        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            wb.save(tmp_path)
            md = main.extract_excel(tmp_path)
            self.assertIn("| 软研中心 | 团队Alpha | 90 |", md)
            self.assertIn("| 软研中心 | 团队Beta | 88 |", md)
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_extract_docx_chinese_headings_and_pseudo_headings(self):
        import docx
        doc = docx.Document()
        p1 = doc.add_paragraph("第一章 基础建设规范")
        r1 = p1.runs[0]
        r1.bold = True

        p2 = doc.add_paragraph("这是正文说明段落。")

        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "项目"
        table.cell(0, 1).text = "进度"
        table.cell(1, 0).text = "核心引擎"
        table.cell(1, 1).text = "100%"

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            md, images = main.extract_docx(tmp_path)
            self.assertEqual(images, [])
            self.assertIn("# 第一章 基础建设规范", md)
            self.assertIn("这是正文说明段落。", md)
            self.assertIn("| 项目 | 进度 |", md)
            self.assertIn("| 核心引擎 | 100% |", md)
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_pptx_spatial_2d_sorting(self):
        from pptx import Presentation
        from pptx.util import Inches
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        # Add shape on bottom/right FIRST
        s1 = slide.shapes.add_textbox(Inches(5), Inches(4), Inches(3), Inches(1))
        s1.text_frame.text = "底部附注"
        # Add title on top SECOND
        s2 = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(6), Inches(1))
        s2.text_frame.text = "架构顶层设计"
        # Add body in middle THIRD
        s3 = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1))
        s3.text_frame.text = "中间核心模块"

        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            prs.save(tmp_path)
            blocks, _ = main.extract_pptx_native(tmp_path)
            content = blocks[0]
            # Verify spatial order: Title -> Middle -> Bottom
            pos_title = content.find("架构顶层设计")
            pos_middle = content.find("中间核心模块")
            pos_bottom = content.find("底部附注")
            self.assertTrue(0 <= pos_title < pos_middle < pos_bottom)
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_extract_docx_collects_embedded_images_with_placeholder(self):
        import io

        import docx
        from PIL import Image

        doc = docx.Document()
        doc.add_paragraph("正文前段")
        img = Image.new("RGB", (200, 120), color=(200, 80, 80))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        doc.add_picture(buf, width=docx.shared.Inches(1.2))
        doc.add_paragraph("正文后段")

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            md, images = main.extract_docx(tmp_path)
            self.assertEqual(len(images), 1)
            self.assertEqual(images[0]["key"], "docx-media-1")
            self.assertGreater(len(images[0]["blob"]), 100)
            self.assertIn("<!-- image: docx-media-1 -->", md)
            self.assertLess(md.index("正文前段"), md.index("<!-- image: docx-media-1 -->"))
            self.assertLess(md.index("<!-- image: docx-media-1 -->"), md.index("正文后段"))
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_is_image_ocr_worthy_size_gate(self):
        import io

        from PIL import Image

        def png(w, h, color=(10, 20, 30)):
            buf = io.BytesIO()
            Image.new("RGB", (w, h), color=color).save(buf, format="PNG")
            return buf.getvalue()

        self.assertFalse(main.is_image_ocr_worthy(b""))
        self.assertFalse(main.is_image_ocr_worthy(png(8, 8)))
        self.assertFalse(main.is_image_ocr_worthy(b"not-an-image" * 400))
        self.assertTrue(main.is_image_ocr_worthy(png(200, 120)))
        self.assertTrue(main.is_image_ocr_worthy(png(64, 64)))

    async def test_docx_embedded_image_ocr_text_is_searchable(self):
        import io
        from unittest.mock import AsyncMock

        import docx
        from PIL import Image

        doc = docx.Document()
        doc.add_paragraph("机房运维规范正文")
        img = Image.new("RGB", (400, 240), color=(200, 80, 80))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        doc.add_picture(buf, width=docx.shared.Inches(2.0))
        doc.add_paragraph("后续说明")

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            docx_bytes = tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

        fake_ocr = (
            "机房温控阈值设定为26摄氏度\n相对湿度不得超过60%",
            {
                "ocr_provider": "baidu",
                "ocr_words_result_num": 2,
                "ocr_average_confidence": 0.93,
            },
        )
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "LOCAL_DOCLING_ENABLED", False),
            patch.object(main, "OCR_PROVIDER", "baidu"),
            patch.object(
                main, "convert_image_with_baidu_ocr", AsyncMock(return_value=fake_ocr)
            ) as baidu,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://parser"
            ) as client:
                response = await client.post(
                    "/parse-execute",
                    files={
                        "file": (
                            "ops.docx",
                            docx_bytes,
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        )
                    },
                    data={
                        "ocr_provider": "baidu",
                        "ocr_api_key": "k",
                        "ocr_secret_key": "s",
                    },
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result["status"], "completed")
            markdown = result["markdown"]
            self.assertIn("机房温控阈值设定为26摄氏度", markdown)
            self.assertIn("### 图片文字", markdown)
            self.assertLess(markdown.index("机房运维规范正文"), markdown.index("机房温控阈值"))
            self.assertLess(markdown.index("机房温控阈值"), markdown.index("后续说明"))
            self.assertEqual(result.get("ocr_image_count"), 1)
            self.assertEqual(result.get("embedded_image_count"), 1)
            baidu.assert_awaited_once()

    async def test_docx_small_image_skips_ocr(self):
        import io
        from unittest.mock import AsyncMock

        import docx
        from PIL import Image

        doc = docx.Document()
        doc.add_paragraph("正文")
        img = Image.new("RGB", (16, 16), color=(200, 80, 80))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        doc.add_picture(buf, width=docx.shared.Inches(0.1))

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            docx_bytes = tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "LOCAL_DOCLING_ENABLED", False),
            patch.object(main, "OCR_PROVIDER", "baidu"),
            patch.object(
                main, "convert_image_with_baidu_ocr", AsyncMock(return_value=("x", {}))
            ) as baidu,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://parser"
            ) as client:
                response = await client.post(
                    "/parse-execute",
                    files={
                        "file": (
                            "icon.docx",
                            docx_bytes,
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        )
                    },
                    data={"ocr_provider": "baidu"},
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result["status"], "completed")
            self.assertIn("装饰性小图，跳过 OCR", result["markdown"])
            self.assertEqual(result.get("ocr_image_count"), 0)
            baidu.assert_not_awaited()

    async def test_pdf_embedded_large_image_ocred_small_skipped(self):
        import io
        import zlib

        from PIL import Image

        def build_pdf_with_text_and_images() -> bytes:
            """Minimal PDF: one native-text page + one large figure + one icon."""
            large = Image.new("RGB", (320, 200), color=(30, 90, 160))
            # Noise so the large figure is not a tiny compressed solid fill.
            for x in range(0, 320, 4):
                for y in range(0, 200, 4):
                    large.putpixel((x, y), (x % 256, y % 256, (x * y) % 256))
            small = Image.new("RGB", (12, 12), color=(200, 30, 30))
            large_raw = zlib.compress(large.convert("RGB").tobytes())
            small_raw = zlib.compress(small.convert("RGB").tobytes())
            content = (
                b"BT /F1 12 Tf 40 280 Td (architecture diagram and notes) Tj ET\n"
                b"q 320 0 0 200 40 40 cm /Im0 Do Q\n"
                b"q 12 0 0 12 350 250 cm /Im1 Do Q\n"
            )
            objects = []

            def add(payload: bytes) -> int:
                objects.append(payload)
                return len(objects)

            font_id = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
            im0_id = add(
                b"<< /Type /XObject /Subtype /Image /Width 320 /Height 200 "
                b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                b"/Length %d >>\nstream\n" % len(large_raw)
                + large_raw
                + b"\nendstream"
            )
            im1_id = add(
                b"<< /Type /XObject /Subtype /Image /Width 12 /Height 12 "
                b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                b"/Length %d >>\nstream\n" % len(small_raw)
                + small_raw
                + b"\nendstream"
            )
            content_id = add(
                b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
            )
            page_id = add(
                b"<< /Type /Page /Parent 3 0 R /MediaBox [0 0 400 320] "
                b"/Resources << /Font << /F1 %d 0 R >> /XObject << /Im0 %d 0 R /Im1 %d 0 R >> >> "
                b"/Contents %d 0 R >>" % (font_id, im0_id, im1_id, content_id)
            )
            pages_id = add(
                b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>" % page_id
            )
            # page_id referenced Parent 3 0 R which is this pages object only if
            # it lands at index 3; rebuild page object with the real parent id.
            objects[page_id - 1] = (
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 400 320] "
                b"/Resources << /Font << /F1 %d 0 R >> /XObject << /Im0 %d 0 R /Im1 %d 0 R >> >> "
                b"/Contents %d 0 R >>" % (pages_id, font_id, im0_id, im1_id, content_id)
            )
            catalog_id = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

            out = bytearray(b"%PDF-1.4\n")
            offsets = [0]
            for index, body in enumerate(objects, start=1):
                offsets.append(len(out))
                out.extend(f"{index} 0 obj\n".encode("ascii"))
                out.extend(body)
                out.extend(b"\nendobj\n")
            xref_pos = len(out)
            out.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
            out.extend(b"0000000000 65535 f \n")
            for off in offsets[1:]:
                out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
            out.extend(
                f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
                f"startxref\n{xref_pos}\n%%EOF\n".encode("ascii")
            )
            return bytes(out)

        pdf_bytes = build_pdf_with_text_and_images()

        fake_ocr = (
            "架构图核心节点说明",
            {"ocr_provider": "baidu", "ocr_words_result_num": 1, "ocr_average_confidence": 0.91},
        )
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "LOCAL_DOCLING_ENABLED", False),
            patch.object(main, "OCR_PROVIDER", "baidu"),
            patch.object(main, "PDF_PARSE_MODE", "fast"),
            patch.object(
                main, "convert_image_with_baidu_ocr", AsyncMock(return_value=fake_ocr)
            ) as baidu,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://parser"
            ) as client:
                response = await client.post(
                    "/parse-execute",
                    files={"file": ("arch.pdf", pdf_bytes, "application/pdf")},
                    data={"ocr_provider": "baidu"},
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result["status"], "completed", result.get("error"))
            self.assertIn("architecture diagram and notes", result["markdown"])
            self.assertIn("架构图核心节点说明", result["markdown"])
            self.assertIn("### 图片文字", result["markdown"])
            # Only the large figure is OCR-eligible.
            self.assertEqual(baidu.await_count, 1)
            self.assertEqual(result.get("ocr_image_count"), 1)

    async def test_ocr_embedded_images_endpoint_enriches_docx(self):
        import io

        import docx
        from PIL import Image

        doc = docx.Document()
        doc.add_paragraph("系统架构说明正文")
        img = Image.new("RGB", (400, 240), color=(40, 90, 160))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        doc.add_picture(buf, width=docx.shared.Inches(2.0))
        doc.add_paragraph("附录")

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            docx_bytes = tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

        fake_ocr = (
            "网关节点部署于核心区",
            {"ocr_provider": "baidu", "ocr_words_result_num": 1, "ocr_average_confidence": 0.9},
        )
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "OCR_PROVIDER", "baidu"),
            patch.object(
                main, "convert_image_with_baidu_ocr", AsyncMock(return_value=fake_ocr)
            ) as baidu,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://parser"
            ) as client:
                response = await client.post(
                    "/ocr-embedded-images",
                    files={
                        "file": (
                            "arch.docx",
                            docx_bytes,
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        )
                    },
                    data={"ocr_provider": "baidu"},
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertIn("网关节点部署于核心区", result["markdown"])
            self.assertEqual(result.get("embedded_image_count"), 1)
            self.assertEqual(result.get("ocr_image_count"), 1)
            baidu.assert_awaited_once()

    async def test_ocr_embedded_images_endpoint_skips_small(self):
        import io

        import docx
        from PIL import Image

        doc = docx.Document()
        doc.add_paragraph("正文")
        img = Image.new("RGB", (12, 12), color=(200, 30, 30))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        doc.add_picture(buf, width=docx.shared.Inches(0.1))

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            doc.save(tmp_path)
            docx_bytes = tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(main, "UPLOAD_ROOT", Path(root)),
            patch.object(main, "OCR_PROVIDER", "baidu"),
            patch.object(
                main, "convert_image_with_baidu_ocr", AsyncMock(return_value=("x", {}))
            ) as baidu,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://parser"
            ) as client:
                response = await client.post(
                    "/ocr-embedded-images",
                    files={
                        "file": (
                            "icon.docx",
                            docx_bytes,
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        )
                    },
                    data={"ocr_provider": "baidu"},
                )
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertIn("装饰性小图，跳过 OCR", result.get("markdown", ""))
            self.assertEqual(result.get("ocr_image_count"), 0)
            baidu.assert_not_awaited()
