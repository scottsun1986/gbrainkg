#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLMWiki 系统测试 - 测试文档生成器
覆盖: 14 种格式 x 6 档大小 x 6 类复杂结构
"""
import csv, io, json, os, random, string, sys, zipfile
from pathlib import Path

OUT = Path("/tmp/opencode/testdocs/files")
OUT.mkdir(parents=True, exist_ok=True)

CJK_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
if not os.path.exists(CJK_FONT):
    import glob
    cands = glob.glob("/usr/share/fonts/opentype/noto/NotoSansCJK*.ttc") + \
            glob.glob("/usr/share/fonts/**/NotoSansCJK*", recursive=True)
    CJK_FONT = cands[0] if cands else None

random.seed(42)

def w(name: str, data: bytes):
    p = OUT / name
    p.write_bytes(data)
    print(f"  {name:44s} {len(data)/1024:10.1f} KB")

# ============ S2: 法律条款结构(事实在首/中/尾) ============
def legal_markdown():
    lines = ["# 无人机运行安全管理条例（测试样例 V2026）", "",
             "## 第一章 总则"]
    for i in range(1, 9):
        lines.append(f"第{i}条 本条例第{i}项总则条款，规定安全管理的基本原则与适用范围" * 2)
    lines += ["", "## 第二章 飞行运行管理"]
    for i in range(9, 60):
        lines.append(f"第{i}条 运行管理条款{i}：飞行前检查、空域申报与运行限制的具体要求。" + "实施细则与罚则衔接。" * 3)
    lines += ["", "## 第三章 检测与维护"]
    # 中部锚点事实
    lines.append("第三十一条 关键事实锚点【中部】：激光陀螺仪标定周期不得超过45个自然日，超期未标定的设备必须立即停飞并送检。")
    for i in range(61, 120):
        lines.append(f"第{i}条 检测维护条款{i}：定期检测、故障处置与记录保存要求。" + "维护记录应保存至少三年备查。" * 2)
    lines += ["", "## 第四章 罚则"]
    lines.append("第一百零一条 关键事实锚点【尾部】：在禁飞区违规起降的，处10万元以上50万元以下罚款，并没收违法所得。")
    for i in range(102, 140):
        lines.append(f"第{i}条 罚则条款{i}：对应违法情形的处罚标准与执行程序。" * 3)
    lines += ["", "## 附则"]
    lines.append("附则关键事实锚点【首部附近补充】：本条例自2026年1月1日起施行，原2024版条例同时废止。")
    return "\n".join(lines)

# ============ S1: 多级标题嵌套 ============
def deep_heading_md():
    lines = ["# 一级标题：产品总体架构", ""]
    body = "产品体系说明文字。" * 20
    for l2 in range(1, 5):
        lines.append(f"## 二级标题 {l2}：模块群 {l2}")
        lines.append(body)
        for l3 in range(1, 4):
            lines.append(f"### 三级标题 {l2}.{l3}：子模块")
            lines.append(body[:200])
            for l4 in range(1, 3):
                lines.append(f"#### 四级标题 {l2}.{l3}.{l4}：组件")
                lines.append("组件职责说明。" * 15)
                if l4 == 1:
                    lines.append(f"##### 五级标题：接口清单 {l2}.{l3}")
                    lines.append("接口描述。" * 10)
                    lines.append(f"###### 六级标题：参数表 {l2}.{l3}.{l4}")
                    lines.append("参数说明。" * 8)
    return "\n".join(lines)

# ============ S3: 宽表/长表 ============
def big_table_md():
    lines = ["# 2026年度设备运维考核指标总表", "",
             "| 设备编号 | 设备名称 | 负责班组 | 一级指标权重 | 二级指标权重 | 巡检周期(天) | 检测项数 | 备件库存下限 | 备注 |",
             "|---|---|---|---|---|---|---|---|---|"]
    for i in range(1, 81):
        remark = "重点保障设备" if i % 7 == 0 else "常规设备"
        lines.append(f"| EQ-{i:04d} | 智能巡检机器人{i}号 | 班组{chr(65+i%5)} | {random.randint(5,20)}% | {random.randint(1,9)}% | {random.choice([7,15,30])} | {random.randint(4,18)} | {random.randint(2,20)} | {remark} |")
    lines += ["", "表格关键锚点事实：编号 EQ-0077 的设备巡检周期为30天，属重点保障设备，备件库存下限17件。"]
    return "\n".join(lines)

# ============ S4: 混合语言/特殊字符 ============
def mixed_charset_md():
    return """# 中英混排与特殊字符测试文档 Mixed Content Test

## English Section
The quick brown fox jumps over the lazy dog. Special chars: @#$%^&*()_+-=[]{}|;':\",./<>?`~

## 中文特殊内容
- emoji 测试：🚁📡🔋⚠️✅❌🔧
- 全角符号：１２３４５６７８９０（）【】《》、！？；：
- 生僻字：龘靐齉爩鱻麤龗灪吁
- 数学/单位：±×÷≈≤≥‰℃㎏㎡μΩ∑∞

## 代码块
```python
def hello():
    print("Hello, 世界! 🌍")
    return 42  # 未闭合于下一节
```

## HTML 内嵌（应被安全处理）
<script>alert('xss-test')</script>
<img src=x onerror=alert(1)>

## 关键锚点
混合文档锚点事实：MIXDOC-KEY-2026 = 「ΨOmega-7 协议激活码」。
"""

# ============ S5: 超长文档（首/中/尾锚点） ============
def ultra_long_md():
    parts = ["# 集团信息化建设总体规划纲要（超长测试文档）", ""]
    parts.append("首部锚点事实【HEAD】：项目总代号「天穹-2026」，总预算为3.75亿元人民币，建设周期36个月。")
    filler = "本节阐述信息化建设的背景、现状与挑战，围绕数据治理、平台架构、安全合规三条主线展开系统性论述。" * 6
    for ch in range(1, 21):
        parts.append(f"\n## 第{ch}章 建设领域 {ch}\n")
        parts.append(filler)
        if ch == 10:
            parts.append("\n中部锚点事实【MIDDLE】：第十章明确要求所有子系统 API 平均响应时间 P95 不超过 800 毫秒，可用性不低于 99.95%。\n")
        for s in range(1, 6):
            parts.append(f"### {ch}.{s} 子领域 {ch}.{s}\n")
            parts.append(filler[:400])
    parts.append("\n尾部锚点事实【TAIL】：本纲要的解释权归集团信息化委员会所有，修订须经不少于三分之二成员表决通过。\n")
    return "\n".join(parts)

# ============ S6: 畸形 Markdown ============
def malformed_md():
    return """# 畸形结构测试

## 未闭合代码块
```bash
echo "this fence is never closed
段落继续...

##|表格格式错误
|列1|列2
|值A

###连标题空格都没有

- 列表项1
  - 嵌套列表
    - 深层嵌套
      - 更深层
        - 最深层

> 引用块
>> 嵌套引用
>>> 三层引用

[断开的链接](
![断开的图片][ref]

另一段正文。畸形锚点事实：MALFORMED-KEY-99。
"""

print("=== Markdown 系 ===")
w("01_tiny_note.md", "# 便签\n\n这是一个极小的 Markdown 文件，用于测试最小文档解析。\n".encode())
w("02_legal_clauses.md", legal_markdown().encode())
w("03_deep_headings.md", deep_heading_md().encode())
w("04_big_table.md", big_table_md().encode())
w("05_mixed_charset.md", mixed_charset_md().encode())
w("06_ultra_long_25k.md", ultra_long_md().encode())
w("07_malformed.md", malformed_md().encode())

print("=== 文本/CSV/HTML 系 ===")
w("10_plain_text.txt", "".join(f"第{i}行：这是纯文本会议纪要内容，记录讨论要点与行动项。\n" for i in range(300)).encode())
csv_buf = io.StringIO()
writer = csv.writer(csv_buf)
writer.writerow(["工号", "姓名", "部门", "入职日期", "职级", "绩效"])
for i in range(500):
    writer.writerow([f"EMP{i:05d}", f"员工{i}", random.choice(["研发","市场","财务","人力"]), f"20{random.randint(18,25)}-{random.randint(1,12):02d}-{random.randint(1,28):02d}", random.randint(1,15), random.choice(["A","B+","B","C"])])
csv_buf.write("\nCSV关键锚点：工号EMP00077的员工绩效为A，入职日期为2021年。")
w("11_roster.csv", csv_buf.getvalue().encode())
html = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>产品介绍</title></head><body>
<h1>智能知识库平台产品介绍</h1>
<h2>产品定位</h2><p>面向企业的知识管理与智能问答平台。HTML锚点事实：HTMLDOC-KEY-产品编号 PRD-2026-8899。</p>
<h2>功能清单</h2><table><tr><th>功能</th><th>状态</th></tr><tr><td>多格式解析</td><td>已上线</td></tr><tr><td>权限隔离</td><td>已上线</td></tr></table>
<h2>客户案例</h2><ul><li>某省政务云</li><li>某金融集团</li></ul>
<script>alert('html-xss')</script>
</body></html>"""
w("12_product_intro.html", html.encode())

print("=== Office 系（python-docx / openpyxl / python-pptx） ===")
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

def make_docx(sections=60, with_table=True, name="20_regulation.docx"):
    doc = Document()
    doc.add_heading("设备安全管理办法（测试文档 V3）", 0)
    doc.add_paragraph("首部锚点事实【DOCX-HEAD】：本办法适用于集团全部生产基地，安全责任落实实行一票否决制。")
    for i in range(1, sections + 1):
        doc.add_heading(f"第{i}章 管理要求", level=1)
        for j in range(1, 4):
            doc.add_heading(f"第{i}条第{j}款", level=2)
            doc.add_paragraph("具体管理条款内容：" + "各单位应建立台账制度，定期开展隐患排查与整改闭环管理。" * 3)
        if i == sections // 2 and with_table:
            doc.add_paragraph("中部锚点事实【DOCX-MIDDLE】：特种设备检验有效期统一为12个月，逾期设备严禁启用。")
            tbl = doc.add_table(rows=12, cols=5)
            hdr = ["风险等级", "检查频次", "责任人", "报告路径", "整改时限"]
            for c, h in enumerate(hdr): tbl.rows[0].cells[c].text = h
            for r in range(1, 12):
                for c in range(5): tbl.rows[r].cells[c].text = f"数据{r}-{c}"
    if with_table:
        doc.add_paragraph("尾部锚点事实【DOCX-TAIL】：违反本办法造成事故的，按事故等级处责任人通报批评至解除劳动合同。")
    doc.save(OUT / name)

make_docx(name="20_regulation.docx")
print(f"  20_regulation.docx 已生成")

# 大 docx：多段落填充至 ~3MB
doc = Document()
doc.add_heading("大数据量测试文档（约3MB）", 0)
para = "大规模文档压力测试段落，包含常规业务描述与结构化信息，用于验证大文件解析性能与完整性。" * 8
for i in range(2600):
    doc.add_heading(f"记录 {i}", level=2)
    doc.add_paragraph(para)
doc.add_paragraph("大文件锚点事实【BIGDOC-KEY】：BIGDOC-VERIFY-7788-总记录数2600。")
doc.save(OUT / "21_large_3mb.docx")
print("  21_large_3mb.docx 已生成")

import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "考核表"
ws.append(["序号","项目","得分","权重","评级","备注"])
for i in range(1, 2001):
    ws.append([i, f"考核项{i}", round(random.uniform(60,100),1), f"{random.randint(1,10)}%", random.choice(["优","良","中","差"]), "自动化" if i%3==0 else "人工"])
ws2 = wb.create_sheet("汇总")
ws2.append(["统计项","数值"]); ws2.append(["总记录",2000]); ws2.append(["锚点事实","XLSX-KEY-汇总表编号SUM-2026-5566"])
wb.save(OUT / "22_assessment_2krows.xlsx")
print("  22_assessment_2krows.xlsx 已生成")

# 大 xlsx ~30MB（10万行）
wb = openpyxl.Workbook(); ws = wb.active
for i in range(1, 100001):
    ws.append([i, f"条目{i}", f"分类{chr(65+i%26)}", round(random.uniform(0,1000),3), "x"*18])
wb.save(OUT / "23_large_100krows.xlsx")
print("  23_large_100krows.xlsx 已生成")

from pptx import Presentation
from pptx.util import Inches
prs = Presentation()
layout = prs.slide_layouts[1]
for i in range(1, 61):
    s = prs.slides.add_slide(layout)
    s.shapes.title.text = f"培训课件 第{i}讲"
    s.placeholders[1].text = f"第{i}讲内容要点：安全规程要点讲解。" * 4
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "关键结论"
s.placeholders[1].text = "PPTX锚点事实：PPTX-KEY-结业考核通过线为85分。"
prs.save(OUT / "24_training_60slides.pptx")
print("  24_training_60slides.pptx 已生成")

print("=== PDF 系（reportlab + STSong-Light CID） ===")
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

def make_pdf(pages, name, title, head_fact=None, mid_fact=None, tail_fact=None):
    st_h = ParagraphStyle("h", fontName="STSong-Light", fontSize=15, alignment=1, spaceAfter=10)
    st_b = ParagraphStyle("b", fontName="STSong-Light", fontSize=10.5, leading=16)
    body = ("本页详细阐述系统设计方案中的技术选型、架构分层、接口规范与部署要求，逐项论证其可行性与风险控制措施。" * 8)
    doc = SimpleDocTemplate(str(OUT / name), pagesize=A4,
                            leftMargin=20*mm, rightMargin=20*mm,
                            topMargin=18*mm, bottomMargin=18*mm)
    story = []
    for p in range(1, pages + 1):
        story.append(Paragraph(f"{title} — 第{p}页", st_h))
        if p == 1 and head_fact:
            story.append(Paragraph(f"【首页锚点】{head_fact}", st_b))
            story.append(Spacer(1, 6))
        if p == pages // 2 and mid_fact:
            story.append(Paragraph(f"【中页锚点】{mid_fact}", st_b))
            story.append(Spacer(1, 6))
        if p == pages and tail_fact:
            story.append(Paragraph(f"【末页锚点】{tail_fact}", st_b))
            story.append(Spacer(1, 6))
        for _ in range(4):
            story.append(Paragraph(body, st_b))
            story.append(Spacer(1, 5))
    doc.build(story)

make_pdf(12, "30_whitepaper_12p.pdf", "智能平台技术白皮书",
         head_fact="PDF锚点事实【HEAD】：白皮书版本号 WP-2026-R9，密级为内部公开。",
         mid_fact="PDF锚点事实【MID】：第六页载明单集群支撑并发会话数不低于2000。",
         tail_fact="PDF锚点事实【TAIL】：末页载明联系人邮箱为contact@example.cn。")
print("  30_whitepaper_12p.pdf 已生成")
make_pdf(80, "31_longdoc_80p.pdf", "运维手册完整版",
         head_fact="长PDF锚点【HEAD】：手册编号 OM-2026-3001。",
         mid_fact="长PDF锚点【MID】：第40页规定核心交换机主备切换时间小于3秒。",
         tail_fact="长PDF锚点【TAIL】：附录载明值班电话 400-000-1234。")
print("  31_longdoc_80p.pdf 已生成")

print("=== 老格式 / 图片 ===")
# .doc: antiword 支持 MS Word 97 二进制。无 soffice，构造一个简单 WordDocument 兼容测试文件较难 —— 改用负例（伪 .doc）
w("40_fake_legacy.doc", b"PK\x03\x04 not-a-real-doc-but-zip-magic".ljust(4096, b"\x00"))

from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype(CJK_FONT, 28)
img = Image.new("RGB", (800, 400), "white")
d = ImageDraw.Draw(img)
d.text((40, 60), "图片OCR测试样张", font=font, fill="black")
d.text((40, 140), "图片锚点事实：IMGOCR-KEY-编号 9527", font=font, fill="black")
d.rectangle([30, 30, 770, 370], outline="blue", width=2)
img.save(OUT / "41_ocr_test.png")
print("  41_ocr_test.png 已生成")

print("=== 边界 / 异常 ===")
w("50_empty.txt", b"")
w("51_whitespace.md", "   \n\n\t \n  \n".encode())
w("52_corrupt.docx", (b"PK\x03\x04" + os.urandom(2048)))
w("53_corrupt.pdf", (b"%PDF-1.7\n%" + os.urandom(1024) + b"%%EOF"))
w("54_corrupt.xlsx", (b"PK\x03\x04" + os.urandom(512)))
w("55_wrong_ext.exe.__hidden__".replace(".__hidden__", ".exe"), os.urandom(512))  # 应被扩展名白名单拒绝
# 超限文件: 201MB
big = OUT / "56_oversize_201mb.txt"
with open(big, "wb") as f:
    chunk = ("超限边界测试。" * 1000).encode()
    target = 201 * 1024 * 1024
    written = 0
    while written < target:
        f.write(chunk[: min(len(chunk), target - written)])
        written += min(len(chunk), target - written)
print(f"  56_oversize_201mb.txt 已生成 (201MB)")

print("\n全部生成完毕 →", OUT)
