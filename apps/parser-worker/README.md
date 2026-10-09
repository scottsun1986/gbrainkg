# LLMWiki parser worker

Run locally with `python3 src/main.py` or expose the FastAPI app as
`uvicorn src.main:app --host 0.0.0.0 --port 8000`.

Legacy Word `.doc` files are supported through the userland `antiword`
converter and then indexed as extracted UTF-8 text. Set `ANTIWORD_BIN` when
the converter is installed at a different path.

## Format routing and quality gate

The worker accepts Markdown/text/CSV/HTML, `.doc`/`.docx`, PDF, `.xls`/`.xlsx`,
PPTX/legacy PPT, and PNG/JPEG/WebP/TIFF/BMP. Native extraction preserves source
units, typed spreadsheet facts and image anchors. Real content keeps the
operator's permissive publication policy; missing coverage, decoding damage,
OCR confidence and derived descriptions are observable. Empty extraction or
parser scaffolding alone fails. Application permissions govern all persisted
originals and artifacts.

## PDF routing

PDFs use a cost-aware hybrid route:

1. `pypdf` extracts native text and measures meaningful text coverage per page.
2. A normal text PDF is indexed directly without OCR or GPU work.
3. Selected scanned pages in a mixed PDF are sent individually to the configured OCR provider; native-text page pictures receive separate enrichment. The current
   cloud adapter is Baidu's asynchronous document parser, which accepts PDF
   input and returns Markdown. It is enabled only with `OCR_PROVIDER=baidu`.
4. If cloud OCR is unavailable, local Docling is used when
   `LOCAL_DOCLING_ENABLED=1`; otherwise a native-text fallback is used when
   one exists and the task fails clearly for a pure scan.

The parser task response exposes `classification`, `page_count`,
`native_page_ratio`, `native_quality`, `engine`, quality fields, and the OCR
task id/page count. This makes it possible to verify which route was actually
used. The default `OCR_PROVIDER=none` keeps documents on-premises; enabling a
cloud OCR provider is an explicit data egress decision.

Relevant settings:

```text
PDF_PARSE_MODE=hybrid
OCR_PROVIDER=baidu
BAIDU_OCR_API_KEY=...
BAIDU_OCR_SECRET_KEY=...
LOCAL_DOCLING_ENABLED=1
```

## 来源与完整表格契约（0.5）

`POST /parse-execute` 保留旧 Markdown 字段，增加 `source_units`、`assets`、
`coverage`、`native_text_chars` 和 `generated_text_chars`。单元状态为
`processed / failed / skipped`，每个正文单元携带自己的 `markdown` 投影，
图片通过 `anchor` 关联段落、页面或幻灯片；引用区域带 `reference_only`，
不重复计算正文。`char_start / char_end` 使用 Python Unicode 代码点偏移。
`source_kind=visual` 和 `generated_text_chars` 明确标记模型派生解释。
标题、页骨架、图片待处理说明不能作为成功正文；包含真实正文的部分解析
仍保持宽松发布策略，失败/跳过单元可见。

重试仍上传原件，附 multipart `unit_ids`（JSON 字符串数组）；可附
`cache_source_hash`（原件 SHA256，不符返回 409）。Excel 支持 `sheet:<name>`
或返回的表 ID，Word 支持块/图片 ID，PDF 支持页/图片 ID，PPTX 支持
幻灯片/对象/图片 ID，图片支持帧/分区 ID。未选单元标记为 skipped，调用方
需保留旧投影与覆盖信息。QA 预览可传 `small_table_rows=501`，取值 1..501。

Excel `structured_tables` 的 `rows` 保留全部原始行（包括表头）；
`row_count` 也包含表头。`headers / header_columns / header_units` 同序，
列号为 Sheet 绝对 1-based 列。多层表头保留 `header_rows / header_hierarchy`。
`is_header / is_summary` 区分明确表头、原生 Excel totals 行与纵向聚合公式。
无原生 Table 定义时采用保守区域投影并附 `warnings`，不猜业务汇总口径。
单元格保留原始类型、坐标、公式、缓存可用性、格式和合并锚点；合并继承
展示值 `inherited=true` 的 `value` 为 null，不可作为重复事实参与求和。
XLS 显式标记 `formula_capability=cached-only`；不执行宏或刷新外部链接。
数值百分比保留原比例和 `display_scale=100`，文本 `20%` 保留字符串和
`display_scale=1`。表头括号内单位按原文保存，不擅自换算币种或数量级。

默认小表预览 200 行、256 KiB。大表完整事实为 JSONL，表带
`artifact_id`；每行仍是 `{row,cells,is_header,is_summary,...}`。
内部每 1000 行提交恢复批次，缓存由实例、原件哈希和解析契约绑定。
失败重试复用已完成批次，只有完整遍历结束才组装完整产物；
`stream_batches / reused_batches / batch_rows` 可观察恢复效果。

`GET /artifacts/{artifact_id}?instance_id=<server-instance>` 与解析接口使用
相同 Bearer 鉴权。产物随机 ID、实例绑定、1 小时 TTL，返回 `no-store`；
表为 NDJSON，大图片资产为原始二进制；单请求 inline 资产合计最多 4 MiB，其余转安全产物，同哈希资源复用同一派生文件。调用方必须立即流式复制到自身
文档权限范围内的持久化存储。Worker 本地派生产物不是用户下载入口。

原生 Office/PDF/图片解析、Docling、旧 PPT 转换均运行于可终止子进程。
默认原生任务 1.5 GiB 地址空间与 240 秒 CPU 限额；主任务占共享实例公平
队列，默认 4 GiB 共享内存预算将主并发压至 2。OCR/VLM 在主槽内顺序执行，
因此同样受共享并发约束。上传与原生临时输出按实际字节跨进程锁控预算，
结构化产物有独立共享磁盘预算、单产物 200 MiB 限额与 TTL 清理；兼容异步任务保留预算计算全部 JSON 元数据和资产，而不是只计算 Markdown。
`PARSER_TABLE_MAX_CELLS` 默认 500 万有效单元格，行/列分别 100 万/1024；
Office 展开体积默认 512 MiB。图片默认单帧 8000 万像素、累计 2 亿像素、
200 帧，长截图采用明确重叠的受限分区；原始 TIFF/WebP/BMP 接收后必须
通过格式解码与像素检查。旧 `.ppt` 依赖本机 soffice，私有冷启动配置禁用
宏/Java/自动外链更新；缺少转换器时明确失败，绝不修改共享 Office 服务。

离线验证：安装 `.[test,pdf-render]` 后运行 `python3 -m pytest tests -q`。
万/十万行资源报告脚本为
`scripts/benchmark_structured_excel.py --rows 10000 100000 --output /tmp/parser-spreadsheet-resource.json`，
输出完整事实数、冷/暖耗时、RSS、产物体积与批次复用。脚本不连接生产服务。

Required runtime installation is `pip install -r requirements.lock.txt`; bare/systemd hosts also need `apt-get install antiword libreoffice-impress`. Docker and bootstrap dependency lists explicitly include PyMuPDF 1.28.2 and Pillow 12.1.1. `/health` reports installed PDF regions, image frames and legacy PPT conversion capabilities.
