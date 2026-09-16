import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import main


class ExecuteContractTests(unittest.IsolatedAsyncioTestCase):
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
                self.assertEqual(result['quality_status'], 'needs_review')
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
            md = main.extract_docx(tmp_path)
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

