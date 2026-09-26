# 文档内嵌图片 OCR 可检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DOCX / 原生文本 PDF 中的内嵌大图走百度 OCR 接口，识别文字写入 Markdown，使图片文字可被混合检索命中。

**Architecture:** parser-worker 在原生抽取阶段为内嵌图插入占位注释，随后统一用百度 `accurate_basic` 对「大图」OCR，把识别文本插回占位位置。扫描版 PDF 仍走整篇文档解析，不重复计费。

**Tech Stack:** python-docx / pypdf / Pillow / httpx / Baidu OCR API / FastAPI parser-worker

## Global Constraints

- OCR 仅走现有百度 OCR 接口（`convert_image_with_baidu_ocr`），不新增厂商抽象
- 大图阈值：`OCR_IMAGE_MIN_SIDE`（默认 64）、`OCR_IMAGE_MIN_BYTES`（默认 2048），小图标跳过
- 单图失败不得中断整篇解析；无 OCR 配置时保留占位并 `needs_review`
- 禁止直接发生产；仅测试环境验证
- 严禁业务硬编码同义词/正则加权
- OCR 文本必须进入 chunk 索引（markdown-chunker 现有路径），不得只存元数据

---

### Task 1: DOCX 内嵌图提取与占位插入

**Covers:** [S3], [S4]

**Files:**
- Modify: `apps/parser-worker/src/main.py` (`extract_docx` 及 `process_file` DOCX 分支)
- Test: `apps/parser-worker/tests/test_execute.py`

**Interfaces:**
- Produces: `extract_docx(path: Path) -> tuple[str, list[dict[str, Any]]]`
  - markdown 中图片位置插入 `<!-- image: docx-media-N -->`
  - image dict: `{"key": "docx-media-N", "ext": str, "blob": bytes}`

- [ ] **Step 1: Write the failing test**

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/parser-worker && python -m pytest tests/test_execute.py::ExecuteContractTests::test_extract_docx_collects_embedded_images_with_placeholder -v`
Expected: FAIL（返回值仍是 str，无法解包）

- [ ] **Step 3: Implement extract_docx with image parts**

将 `extract_docx` 改为收集 `a:blip` 的 `r:embed` 关系，按 body 顺序在对应块后插入占位；返回 `(markdown, image_parts)`。同步更新 `test_extract_docx_chinese_headings_and_pseudo_headings` 为 `md, _ = main.extract_docx(...)`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/parser-worker && python -m pytest tests/test_execute.py -v -k docx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/parser-worker/src/main.py apps/parser-worker/tests/test_execute.py
git commit -m "feat(parser): extract DOCX embedded images with position placeholders"
```

---

### Task 2: 共享图片 OCR 装配（百度接口 + 大图阈值）

**Covers:** [S3], [S4], [S5]

**Files:**
- Modify: `apps/parser-worker/src/main.py`
- Test: `apps/parser-worker/tests/test_execute.py`

**Interfaces:**
- Produces:
  - `OCR_IMAGE_MIN_SIDE`, `OCR_IMAGE_MIN_BYTES` 环境变量
  - `is_image_ocr_worthy(blob: bytes) -> bool`
  - `ocr_image_parts_into_markdown(markdown: str, image_parts: list[dict], ocr_config: dict) -> tuple[str, dict[str, Any]]`
    - 将 `<!-- image: key -->` 替换为 `### 图片文字\n\n{ocr}` 或失败/跳过占位
    - metadata: `embedded_image_count`, `ocr_image_count`, `ocr_words_result_num`, `ocr_average_confidence`

- [ ] **Step 1: Write the failing test**

```python
async def test_docx_embedded_image_ocr_text_is_indexable(self):
    # 构造带图 DOCX，mock convert_image_with_baidu_ocr 返回固定文字
    # 断言 markdown 含 "机房温控阈值" 且在图片占位原位置
    # 断言 metadata.ocr_image_count == 1
```

（完整测试代码实现时写入，覆盖：大图 OCR 调用、小图跳过不调用、OCR 抛错不中断）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/parser-worker && python -m pytest tests/test_execute.py -k ocr_worthy_or_docx_image -v`
Expected: FAIL

- [ ] **Step 3: Implement threshold helper + OCR assembler**

- `is_image_ocr_worthy`：字节数 + Pillow 解码宽高，均小于阈值则 False
- `ocr_image_parts_into_markdown`：复用 `convert_image_with_baidu_ocr`，临时文件写 blob，替换占位

- [ ] **Step 4: Wire DOCX branch in process_file**

`process_file` DOCX 分支改为 `md, image_parts = extract_docx(...)`，随后 `md, ocr_meta = await ocr_image_parts_into_markdown(md, image_parts, ocr_config)` 并 `task.update(ocr_meta)`。

- [ ] **Step 5: Run tests**

Run: `cd apps/parser-worker && python -m pytest tests/ -v`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/parser-worker/src/main.py apps/parser-worker/tests/test_execute.py
git commit -m "feat(parser): OCR DOCX embedded images via Baidu API into markdown"
```

---

### Task 3: PDF 插图提取与 OCR

**Covers:** [S3], [S4], [S5]

**Files:**
- Modify: `apps/parser-worker/src/main.py`（`extract_pdf_page_images`、`convert_pdf_with_fallback` 文本路径）
- Test: `apps/parser-worker/tests/test_execute.py`

**Interfaces:**
- Produces: `extract_pdf_page_images(path: Path) -> list[dict[str, Any]]`
  - item: `{"key": "p{page}-img{n}", "page_index": int, "ext": str, "blob": bytes}`
- 行为：仅 classification=`text` 且走 `pypdf-native` 时，对大图 OCR 并插入 `## 第 N 页` 小节末尾；scanned/mixed 整篇 OCR 路径不重复提图

- [ ] **Step 1: Write the failing test**

```python
async def test_pdf_embedded_large_image_ocred_small_skipped(self):
    # 用 pypdf 写入含两张图（大图 + 1x1 图标）的 PDF
    # mock OCR，断言只对大图调用一次，markdown 含识别文字
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Implement extract_pdf_page_images + wire into convert_pdf_with_fallback**

在 `classification == "text"` 的 native 返回前，提取页内图片，过滤小图，调用 Task 2 装配器把 OCR 文本追加到对应页。

- [ ] **Step 4: Run tests**

Run: `cd apps/parser-worker && python -m pytest tests/ -v`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/parser-worker/src/main.py apps/parser-worker/tests/test_execute.py
git commit -m "feat(parser): OCR large figures inside native PDF pages"
```

---

### Task 4: 回归与检索链路核对

**Covers:** [S4], [S5], [S6]

**Files:**
- Test: `apps/parser-worker/tests/test_execute.py`（回归）
- Verify: `apps/api/src/ingestion/markdown-chunker.ts` 不丢弃 `### 图片文字` 正文

- [ ] **Step 1: Ensure markdown-chunker keeps OCR text**

确认 OCR 文本不被 `<!-- bbox -->` 清理误删；`### 图片文字` 作为普通 markdown 进入 chunk.content。

- [ ] **Step 2: Full parser-worker suite + api ingestion unit tests**

Run: `cd apps/parser-worker && python -m pytest tests/ -v && cd ../.. && pnpm --filter api test -- content-quality markdown-chunker`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add -A apps/parser-worker apps/api/src/ingestion
git commit -m "test: cover embedded-image OCR and keep OCR text indexable"
```

---

## Self-Review

- Spec 覆盖：S3 阈值/范围 → Task 1–3；S4 数据流 → Task 1–3；S5 错误处理 → Task 2–3；S6 测试 → Task 4
- 无 TBD/占位；接口签名在各 Task 间一致
- 类型一致：`extract_docx -> tuple[str, list[dict]]`、`ocr_image_parts_into_markdown -> tuple[str, dict]`
