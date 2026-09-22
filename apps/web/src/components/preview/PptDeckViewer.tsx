"use client";

import React, { useState, useEffect, useRef } from "react";

export interface PptDeckViewerProps {
  rawBlob: Blob | null;
  rawBlobUrl: string;
  docData: { markdown_content?: string; [key: string]: unknown } | null;
  filename: string;
  ext: string;
  preview: { pageNo?: number | string; snippet?: string; [key: string]: unknown } | null;
  highlightPhrases?: string[];
  onSwitchToMd?: () => void;
}

interface SlideElement {
  type: "image" | "title" | "text" | "table";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  hasXfrm?: boolean;
  src?: string;
  paragraphs?: { text: string; isBullet?: boolean; isBold?: boolean }[];
  rows?: string[][];
}

interface SlideItem {
  page: number;
  title: string;
  elements: SlideElement[];
  images: string[];
  notes?: string;
  rawText?: string;
}

/**
 * Clean & highlight text helper
 */
function renderHighlightedText(text: string, phrases: string[] = []) {
  if (!text) return null;
  if (!phrases || phrases.length === 0) return <>{text}</>;

  const terms = Array.from(new Set(phrases.map((p) => String(p || "").trim()).filter(Boolean)))
    .slice(0, 40)
    .sort((a, b) => b.length - a.length);

  if (!terms.length) return <>{text}</>;

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) => {
        const isMatch = terms.some((term) => term.toLowerCase() === part.toLowerCase());
        if (isMatch) {
          return (
            <mark key={i} className="doc-citation-highlight">
              {part}
            </mark>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

/**
 * Segmentation fallback for markdown content (or binary .ppt)
 */
function parseMarkdownToSlides(md: string): { deckTitle: string; slides: SlideItem[] } {
  if (!md) return { deckTitle: "", slides: [] };
  const text = md.trim();

  let deckTitle = "";
  let content = text;
  const titleMatch = content.match(/^#\s+([^\n]+)\n+/);
  if (titleMatch && content.includes("## 第")) {
    deckTitle = titleMatch[1].trim();
    content = content.slice(titleMatch[0].length).trim();
  }

  const rawParts = content
    .split(/(?=(?:^|\n)##\s*(?:第\s*)?\d+\s*页)|(?:\n\s*---\s*\n)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const slides: SlideItem[] = [];

  rawParts.forEach((part, idx) => {
    if (part === "---" || part === "***") return;

    const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
    let pageNum = idx + 1;
    let title = "";
    let notes = "";
    const paragraphs: { text: string; isBullet?: boolean; isBold?: boolean }[] = [];
    const tableRows: string[][] = [];

    for (const line of lines) {
      const pageMatch = line.match(/^##\s*(?:第\s*)?(\d+)\s*页/);
      if (pageMatch) {
        pageNum = parseInt(pageMatch[1], 10);
        continue;
      }
      if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) {
        if (!title) {
          title = line.replace(/^#+\s*/, "");
          continue;
        }
      }
      if (/^>\s*\*\*?演讲备注\*\*?[：:]/.test(line)) {
        notes = line.replace(/^>\s*\*\*?演讲备注\*\*?[：:]\s*/, "");
        continue;
      }
      // Table detection
      if (line.startsWith("|") && line.endsWith("|")) {
        if (line.includes("---")) continue;
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        tableRows.push(cells);
        continue;
      }

      const isBullet = line.startsWith("- ") || line.startsWith("* ") || /^\d+\.\s+/.test(line);
      const cleanLine = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
      paragraphs.push({
        text: cleanLine,
        isBullet,
        isBold: /^\*\*.*?\*\*$/.test(cleanLine),
      });
    }

    const elements: SlideElement[] = [];
    if (title) {
      elements.push({
        type: "title",
        paragraphs: [{ text: title, isBold: true }],
      });
    }
    if (paragraphs.length > 0) {
      elements.push({
        type: "text",
        paragraphs,
      });
    }
    if (tableRows.length > 0) {
      elements.push({
        type: "table",
        rows: tableRows,
      });
    }

    slides.push({
      page: pageNum,
      title: title || (deckTitle && pageNum === 1 ? deckTitle : `幻灯片 ${pageNum}`),
      elements,
      images: [],
      notes,
      rawText: part,
    });
  });

  return { deckTitle, slides };
}

export function PptDeckViewer({
  rawBlob,
  rawBlobUrl,
  docData,
  filename,
  ext,
  preview,
  highlightPhrases = [],
  onSwitchToMd,
}: PptDeckViewerProps) {
  const [slides, setSlides] = useState<SlideItem[]>([]);
  const [aspectRatio, setAspectRatio] = useState<number>(16 / 9);
  const [currentSlideIndex, setCurrentSlideIndex] = useState<number>(0);
  const [viewMode, setViewMode] = useState<"slide" | "grid">("slide");
  const [showThumbnails, setShowThumbnails] = useState<boolean>(true);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [parseEngine, setParseEngine] = useState<string>("");

  const containerRef = useRef<HTMLDivElement>(null);
  const slideCanvasRef = useRef<HTMLDivElement>(null);
  const activeThumbnailRef = useRef<HTMLDivElement>(null);
  const objectUrlsRef = useRef<string[]>([]);

  // 1. Parse PPTX binary or Markdown
  useEffect(() => {
    let cancelled = false;

    // Clean previous object URLs
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];

    const doParse = async () => {
      setLoading(true);
      // If we have rawBlob and it's pptx, attempt native OpenXML parse
      if (rawBlob && ext === "pptx") {
        try {
          const JSZipModule = await import("jszip");
          const JSZip = ((JSZipModule as { default?: unknown }).default ?? JSZipModule) as typeof JSZipModule;
          const arrayBuffer = await rawBlob.arrayBuffer();
          const zip = await JSZip.loadAsync(arrayBuffer);

          if (cancelled) return;

          // Dimensions
          let sWidth = 12192000;
          let sHeight = 6858000;
          const presXml = await zip.file("ppt/presentation.xml")?.async("text");
          if (presXml) {
            const m = presXml.match(/<p:sldSz\s+[^>]*cx="(\d+)"\s+cy="(\d+)"/);
            if (m) {
              sWidth = parseInt(m[1], 10) || sWidth;
              sHeight = parseInt(m[2], 10) || sHeight;
            }
          }
          const ratio = sWidth / sHeight;
          setAspectRatio(ratio > 1.5 ? 16 / 9 : 4 / 3);

          // Slide Ordering
          const presRelsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("text");
          const relMap: Record<string, string> = {};
          if (presRelsXml) {
            for (const m of presRelsXml.matchAll(/<Relationship\s+[^>]*Id="([^"]+)"\s+[^>]*Target="([^"]+)"/g)) {
              relMap[m[1]] = m[2].replace(/^(\.\.\/)+/, "").replace(/^ppt\//, "");
            }
          }
          let slidePaths: string[] = [];
          if (presXml) {
            for (const m of presXml.matchAll(/<p:sldId\s+[^>]*r:id="([^"]+)"/g)) {
              if (relMap[m[1]]) slidePaths.push("ppt/" + relMap[m[1]]);
            }
          }
          if (!slidePaths.length) {
            slidePaths = Object.keys(zip.files)
              .filter((f) => f.match(/^ppt\/slides\/slide\d+\.xml$/))
              .sort((a, b) => {
                const nA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
                const nB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
                return nA - nB;
              });
          }

          if (slidePaths.length > 0) {
            const parsedSlides: SlideItem[] = [];

            for (let i = 0; i < slidePaths.length; i++) {
              if (cancelled) return;
              const sPath = slidePaths[i];
              const sXml = await zip.file(sPath)?.async("text");
              if (!sXml) continue;

              // Slide rels for images
              const rPath = sPath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
              const rXml = await zip.file(rPath)?.async("text");
              const sRels: Record<string, string> = {};
              let notesPath = "";
              if (rXml) {
                for (const rm of rXml.matchAll(/<Relationship\s+[^>]*Id="([^"]+)"\s+[^>]*Target="([^"]+)"/g)) {
                  const target = rm[2].replace(/^(\.\.\/)+/, "ppt/");
                  sRels[rm[1]] = target;
                  if (rm[0].includes("notesSlide")) {
                    notesPath = target;
                  }
                }
              }

              // Extract images
              const slideImages: string[] = [];
              const elements: SlideElement[] = [];

              for (const pic of sXml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) {
                const pBody = pic[1];
                const blip = pBody.match(/<a:blip\s+[^>]*r:embed="([^"]+)"/);
                if (blip && sRels[blip[1]]) {
                  const mediaFile = zip.file(sRels[blip[1]]);
                  if (mediaFile) {
                    const extMatch = sRels[blip[1]].split(".").pop()?.toLowerCase();
                    const mime = extMatch === "jpg" || extMatch === "jpeg" ? "image/jpeg" : extMatch === "svg" ? "image/svg+xml" : "image/png";
                    const imgBuf = await mediaFile.async("uint8array");
                    // Copy into a plain ArrayBufferView so the Blob constructor
                    // accepts it under the stricter DOM typings.
                    const imgBlob = new Blob([new Uint8Array(imgBuf)], { type: mime });
                    const imgUrl = URL.createObjectURL(imgBlob);
                    objectUrlsRef.current.push(imgUrl);
                    slideImages.push(imgUrl);

                    // Position
                    let left = 0, top = 0, width = 100, height = 100;
                    const xfrmMatch = pBody.match(/<a:xfrm>([\s\S]*?)<\/a:xfrm>/);
                    if (xfrmMatch) {
                      const off = xfrmMatch[1].match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
                      const extMatch = xfrmMatch[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
                      if (off && extMatch) {
                        left = (parseInt(off[1], 10) / sWidth) * 100;
                        top = (parseInt(off[2], 10) / sHeight) * 100;
                        width = (parseInt(extMatch[1], 10) / sWidth) * 100;
                        height = (parseInt(extMatch[2], 10) / sHeight) * 100;
                      }
                    }

                    elements.push({
                      type: "image",
                      src: imgUrl,
                      left,
                      top,
                      width,
                      height,
                    });
                  }
                }
              }

              // Extract text shapes
              let title = "";
              const textBlocks: { text: string; isBullet?: boolean; isBold?: boolean }[][] = [];

              for (const sp of sXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
                const sBody = sp[1];
                const isTitle = /type="(title|ctrTitle)"/.test(sBody);
                const pMatches = [...sBody.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)];
                const paras: { text: string; isBullet?: boolean; isBold?: boolean }[] = [];

                for (const p of pMatches) {
                  const pXml = p[1];
                  const t = [...pXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("");
                  if (t.trim()) {
                    const isBullet = /lvl="[1-9]"/.test(pXml) || /<a:buChar/.test(pXml);
                    const isBold = /<a:rPr[^>]*\bb="1"/.test(pXml);
                    paras.push({ text: t.trim(), isBullet, isBold });
                  }
                }

                if (paras.length > 0) {
                  if (isTitle && !title) {
                    title = paras.map((p) => p.text).join(" ");
                    elements.push({
                      type: "title",
                      paragraphs: paras,
                    });
                  } else {
                    textBlocks.push(paras);
                    elements.push({
                      type: "text",
                      paragraphs: paras,
                    });
                  }
                }
              }

              // Extract tables
              for (const gf of sXml.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)) {
                const gfBody = gf[1];
                if (gfBody.includes("<a:tbl>")) {
                  const rows: string[][] = [];
                  for (const tr of gfBody.matchAll(/<a:tr[^>]*>([\s\S]*?)<\/a:tr>/g)) {
                    const rowCells = [...tr[1].matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)].map((tc) => {
                      return [...tc[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("");
                    });
                    rows.push(rowCells);
                  }
                  if (rows.length > 0) {
                    elements.push({
                      type: "table",
                      rows,
                    });
                  }
                }
              }

              // Speaker Notes
              let notes = "";
              if (notesPath) {
                const nXml = await zip.file(notesPath)?.async("text");
                if (nXml) {
                  const noteParas = [...nXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ");
                  if (noteParas.trim()) notes = noteParas.trim();
                }
              }

              if (!title && textBlocks.length > 0 && textBlocks[0].length > 0) {
                title = textBlocks[0][0].text;
              }

              parsedSlides.push({
                page: i + 1,
                title: title || `幻灯片 ${i + 1}`,
                elements,
                images: slideImages,
                notes,
                rawText: elements
                  .flatMap((e) => e.paragraphs?.map((p) => p.text) || [])
                  .join(" "),
              });
            }

            if (!cancelled && parsedSlides.length > 0) {
              setSlides(parsedSlides);
              setParseEngine("native-pptx-xml");
              setLoading(false);
              return;
            }
          }
        } catch (err) {
          console.warn("Native PPTX parsing failed, falling back to Markdown slides:", err);
        }
      }

      // 2. Fallback: Parse markdown_content
      if (cancelled) return;
      const { slides: mdSlides } = parseMarkdownToSlides(docData?.markdown_content || "");
      setSlides(mdSlides);
      setParseEngine(ext === "ppt" ? "docling-ppt-segmented" : "docling-markdown-segmented");
      setLoading(false);
    };

    doParse();

    return () => {
      cancelled = true;
    };
  }, [rawBlob, ext, docData?.markdown_content]);

  // 2. Auto-locate to cited page or matching search snippet
  useEffect(() => {
    if (!slides.length) return;
    // Deferred by a tick so the location pass is not a synchronous setState
    // during the effect body (which triggers cascading renders).
    const timer = setTimeout(() => {
      // A. Explicit page number from preview
      const pageNo = typeof preview?.pageNo === 'number' ? preview.pageNo : Number(preview?.pageNo);
      if (pageNo && pageNo >= 1 && pageNo <= slides.length) {
        setCurrentSlideIndex(pageNo - 1);
        return;
      }

      // B. Match by highlight phrases or snippet
      const snippetText = (preview?.snippet || "").trim();
      if (!snippetText && (!highlightPhrases || highlightPhrases.length === 0)) return;

      const phrasesToMatch = highlightPhrases.length > 0 ? highlightPhrases : [snippetText.slice(0, 30)];

      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i];
        const hay = (slide.title + " " + (slide.rawText || "")).toLowerCase();
        if (phrasesToMatch.some((p) => hay.includes(p.toLowerCase()))) {
          setCurrentSlideIndex(i);
          break;
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [slides, preview?.pageNo, preview?.snippet, highlightPhrases]);

  // 3. Scroll active thumbnail into view
  useEffect(() => {
    if (activeThumbnailRef.current) {
      activeThumbnailRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [currentSlideIndex, viewMode]);

  // 4. Keyboard shortcuts for presentation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is in an input
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setCurrentSlideIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        setCurrentSlideIndex((prev) => Math.min(slides.length - 1, prev + 1));
      } else if (e.key === "Home") {
        e.preventDefault();
        setCurrentSlideIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setCurrentSlideIndex(slides.length - 1);
      } else if (e.key === "Escape" && isFullScreen) {
        setIsFullScreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [slides.length, isFullScreen]);

  const currentSlide = slides[currentSlideIndex] || null;

  const handleDownload = () => {
    if (!rawBlobUrl && !rawBlob) return;
    const a = document.createElement("a");
    a.href = rawBlobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleFullScreen = () => {
    setIsFullScreen(!isFullScreen);
  };

  return (
    <div
      ref={containerRef}
      className={`ppt-deck-container ${isFullScreen ? "fullscreen" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "680px",
        background: "var(--surface-2)",
        borderRadius: isFullScreen ? "0" : "8px",
        overflow: "hidden",
        position: isFullScreen ? "fixed" : "relative",
        top: isFullScreen ? 0 : "auto",
        left: isFullScreen ? 0 : "auto",
        width: isFullScreen ? "100vw" : "100%",
        height: isFullScreen ? "100vh" : "100%",
        zIndex: isFullScreen ? 99999 : "auto",
      }}
    >
      {/* 幻灯片顶部控制工具栏 */}
      <div className="ppt-deck-toolbar">
        {/* 左侧：文件与幻灯片信息 */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              background: "#ea580c",
              color: "#fff",
              padding: "2px 8px",
              borderRadius: "4px",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            📽️ {ext.toUpperCase()} 幻灯片
          </span>
          <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>
            {slides.length > 0 ? `第 ${currentSlideIndex + 1} / ${slides.length} 页` : "加载中…"}
          </span>
          {parseEngine && (
            <span
              style={{
                fontSize: "10.5px",
                color: "var(--ink-4)",
                background: "var(--surface)",
                padding: "2px 6px",
                borderRadius: "4px",
                border: "1px solid var(--line)",
              }}
              title={parseEngine}
            >
              {parseEngine === "native-pptx-xml"
                ? "⚡ 原生 OpenXML 幻灯片排版"
                : "💡 智能排版演示播放器"}
            </span>
          )}
        </div>

        {/* 中间：翻页快捷控制与视图切换 */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            type="button"
            className="ppt-deck-btn"
            onClick={() => setCurrentSlideIndex(0)}
            disabled={currentSlideIndex === 0}
            title="第一页 (Home)"
          >
            ⏮
          </button>
          <button
            type="button"
            className="ppt-deck-btn"
            onClick={() => setCurrentSlideIndex((prev) => Math.max(0, prev - 1))}
            disabled={currentSlideIndex === 0}
            title="上一页 (← / PageUp)"
          >
            ◀ 上一页
          </button>

          {/* 幻灯片快速选页 */}
          <select
            value={currentSlideIndex}
            onChange={(e) => setCurrentSlideIndex(parseInt(e.target.value, 10))}
            style={{
              padding: "3px 8px",
              fontSize: "12px",
              borderRadius: "5px",
              border: "1px solid var(--line)",
              background: "var(--surface)",
              color: "var(--ink)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            {slides.map((s, idx) => (
              <option key={idx} value={idx}>
                {idx + 1}. {s.title.slice(0, 22) || `第 ${idx + 1} 页`}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="ppt-deck-btn"
            onClick={() => setCurrentSlideIndex((prev) => Math.min(slides.length - 1, prev + 1))}
            disabled={currentSlideIndex >= slides.length - 1}
            title="下一页 (→ / Space / PageDown)"
          >
            下一页 ▶
          </button>
          <button
            type="button"
            className="ppt-deck-btn"
            onClick={() => setCurrentSlideIndex(slides.length - 1)}
            disabled={currentSlideIndex >= slides.length - 1}
            title="最后一页 (End)"
          >
            ⏭
          </button>

          <div style={{ width: "1px", height: "18px", background: "var(--line)", margin: "0 4px" }} />

          {/* 单页 / 网格总览 切换 */}
          <button
            type="button"
            className={`ppt-deck-btn ${viewMode === "slide" ? "active" : ""}`}
            onClick={() => setViewMode("slide")}
            title="单页放映视图"
          >
            📽️ 单页放映
          </button>
          <button
            type="button"
            className={`ppt-deck-btn ${viewMode === "grid" ? "active" : ""}`}
            onClick={() => setViewMode("grid")}
            title="幻灯片总览网格"
          >
            ▦ 网格总览
          </button>
          <button
            type="button"
            className={`ppt-deck-btn ${showThumbnails ? "active" : ""}`}
            onClick={() => setShowThumbnails(!showThumbnails)}
            title={showThumbnails ? "隐藏侧边胶片栏" : "展开侧边胶片栏"}
          >
            📑 胶片栏
          </button>
        </div>

        {/* 右侧：操作与全屏 */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {rawBlobUrl && (
            <button
              type="button"
              className="ppt-deck-btn primary"
              onClick={handleDownload}
              title="下载 PPTX 原版文件"
            >
              📥 下载原件
            </button>
          )}
          {onSwitchToMd && (
            <button
              type="button"
              className="ppt-deck-btn"
              onClick={onSwitchToMd}
              title="切换至标准化 Markdown 知识页"
            >
              📝 标准化 Markdown
            </button>
          )}
          <button
            type="button"
            className="ppt-deck-btn"
            onClick={toggleFullScreen}
            title={isFullScreen ? "退出全屏 (Esc)" : "全屏放映 (F)"}
          >
            {isFullScreen ? "⛷ 退出全屏" : "⛶ 全屏放映"}
          </button>
        </div>
      </div>

      {/* 主体展示区 */}
      <div className="ppt-deck-stage-wrapper">
        {loading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              width: "100%",
              minHeight: "420px",
              gap: "12px",
            }}
          >
            <div className="streaming-dot" style={{ width: "14px", height: "14px", background: "#ea580c" }} />
            <div style={{ fontSize: "13px", color: "var(--ink-3)" }}>
              正在解析 PPT 幻灯片原生版式与媒体资产…
            </div>
          </div>
        ) : viewMode === "grid" ? (
          /* 网格总览模式 (Slide Sorter) */
          <div className="ppt-grid-container">
            {slides.map((slide, idx) => {
              const isActive = idx === currentSlideIndex;
              const hasImages = slide.images.length > 0;
              return (
                <div
                  key={idx}
                  className={`ppt-grid-card ${isActive ? "active" : ""}`}
                  onClick={() => {
                    setCurrentSlideIndex(idx);
                    setViewMode("slide");
                  }}
                  title={`点击查看第 ${idx + 1} 页: ${slide.title}`}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        background: isActive ? "#ea580c" : "var(--surface-2)",
                        color: isActive ? "#fff" : "var(--ink-3)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        border: "1px solid var(--line)",
                      }}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "180px",
                      }}
                    >
                      {slide.title}
                    </span>
                  </div>

                  <div className="ppt-thumbnail-aspect">
                    {hasImages ? (
                      <img
                        src={slide.images[0]}
                        alt={slide.title}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    ) : (
                      <div
                        style={{
                          padding: "8px",
                          width: "100%",
                          height: "100%",
                          fontSize: "10.5px",
                          color: "var(--ink-3)",
                          overflow: "hidden",
                          lineHeight: "1.4",
                          background: "#fff",
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: "4px" }}>
                          {slide.title}
                        </div>
                        <div>{(slide.rawText || "").slice(0, 80)}…</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* 单页放映模式 */
          <>
            {/* 左侧胶片导览缩略栏 */}
            {showThumbnails && (
              <div className="ppt-deck-sidebar">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "4px 6px 8px",
                    borderBottom: "1px solid var(--line)",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    color: "var(--ink-2)",
                  }}
                >
                  <span>📑 幻灯片导览 ({slides.length})</span>
                </div>

                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    paddingRight: "2px",
                  }}
                >
                  {slides.map((slide, idx) => {
                    const isActive = idx === currentSlideIndex;
                    const hasImage = slide.images.length > 0;
                    return (
                      <div
                        key={idx}
                        ref={isActive ? activeThumbnailRef : null}
                        className={`ppt-thumbnail-card ${isActive ? "active" : ""}`}
                        onClick={() => setCurrentSlideIndex(idx)}
                      >
                        <div className="ppt-thumbnail-aspect">
                          <span className="ppt-thumbnail-badge">{idx + 1}</span>
                          {hasImage ? (
                            <img
                              src={slide.images[0]}
                              alt={slide.title}
                              style={{ width: "100%", height: "100%", objectFit: "contain" }}
                            />
                          ) : (
                            <div
                              style={{
                                padding: "6px",
                                width: "100%",
                                height: "100%",
                                fontSize: "9px",
                                color: "var(--ink-3)",
                                overflow: "hidden",
                                background: "#fff",
                                lineHeight: "1.3",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 700,
                                  color: "var(--ink)",
                                  marginBottom: "2px",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {slide.title}
                              </div>
                              <div>{(slide.rawText || "").slice(0, 40)}</div>
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: isActive ? 600 : 400,
                            color: isActive ? "#ea580c" : "var(--ink-2)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            marginTop: "4px",
                          }}
                          title={slide.title}
                        >
                          {slide.title}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 中间演示文稿主舞台 (The Slide Stage) */}
            <div className="ppt-deck-stage">
              {currentSlide ? (
                <div
                  ref={slideCanvasRef}
                  className="ppt-slide-canvas"
                  style={{
                    aspectRatio: `${aspectRatio}`,
                  }}
                >
                  {/* 左右悬浮翻页指示箭（触控或鼠标直达） */}
                  {currentSlideIndex > 0 && (
                    <button
                      type="button"
                      className="ppt-stage-nav-arrow left"
                      onClick={() => setCurrentSlideIndex((prev) => Math.max(0, prev - 1))}
                      title="上一页"
                    >
                      ‹
                    </button>
                  )}
                  {currentSlideIndex < slides.length - 1 && (
                    <button
                      type="button"
                      className="ppt-stage-nav-arrow right"
                      onClick={() => setCurrentSlideIndex((prev) => Math.min(slides.length - 1, prev + 1))}
                      title="下一页"
                    >
                      ›
                    </button>
                  )}

                  {/* 幻灯片头部标题栏 */}
                  <div className="ppt-slide-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: "10.5px",
                          fontWeight: 700,
                          background: "#ea580c",
                          color: "#fff",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          letterSpacing: "0.5px",
                        }}
                      >
                        SLIDE {String(currentSlide.page).padStart(2, "0")}
                      </span>
                      <h2 className="ppt-slide-title">
                        {renderHighlightedText(currentSlide.title, highlightPhrases)}
                      </h2>
                    </div>
                    <div style={{ fontSize: "11.5px", color: "var(--ink-4)", fontWeight: 500, flexShrink: 0 }}>
                      {filename.slice(0, 24)}
                    </div>
                  </div>

                  {/* 幻灯片主体呈现 */}
                  <div className="ppt-slide-body">
                    {/* A. 如果拥有全屏原生大图 (如导出的高保真幻灯片图) */}
                    {currentSlide.images.length > 0 && currentSlide.elements.filter((e) => e.type === "text").length === 0 ? (
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          position: "relative",
                        }}
                      >
                        <img
                          src={currentSlide.images[0]}
                          alt={currentSlide.title}
                          style={{
                            maxWidth: "100%",
                            maxHeight: "100%",
                            objectFit: "contain",
                            borderRadius: "6px",
                            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                          }}
                        />
                      </div>
                    ) : (
                      /* B. 图文排版与卡片化排版 */
                      <div style={{ display: "flex", flexDirection: "column", gap: "14px", flex: 1 }}>
                        {/* 嵌入图像展示 */}
                        {currentSlide.images.length > 0 && (
                          <div
                            style={{
                              display: "flex",
                              gap: "12px",
                              justifyContent: "center",
                              alignItems: "center",
                              maxHeight: "240px",
                              overflow: "hidden",
                            }}
                          >
                            {currentSlide.images.map((imgUrl, i) => (
                              <img
                                key={i}
                                src={imgUrl}
                                alt={`幻灯片配图 ${i + 1}`}
                                style={{
                                  maxHeight: "220px",
                                  maxWidth: "100%",
                                  objectFit: "contain",
                                  borderRadius: "6px",
                                  border: "1px solid var(--line)",
                                }}
                              />
                            ))}
                          </div>
                        )}

                        {/* 结构化文字块 & 要点卡片 */}
                        {currentSlide.elements
                          .filter((e) => e.type === "text")
                          .map((el, elIdx) => (
                            <div key={elIdx} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                              {el.paragraphs?.map((para, pIdx) => (
                                <div key={pIdx} className="ppt-bullet-card">
                                  <span className="ppt-bullet-dot" />
                                  <div
                                    style={{
                                      flex: 1,
                                      fontWeight: para.isBold ? 600 : 400,
                                      fontSize: "13.5px",
                                      color: "var(--ink)",
                                      lineHeight: "1.6",
                                    }}
                                  >
                                    {renderHighlightedText(para.text, highlightPhrases)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))}

                        {/* 数据表格 */}
                        {currentSlide.elements
                          .filter((e) => e.type === "table")
                          .map((tbl, tIdx) => (
                            <div
                              key={tIdx}
                              style={{
                                overflowX: "auto",
                                border: "1px solid var(--line)",
                                borderRadius: "6px",
                                marginTop: "6px",
                              }}
                            >
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
                                <tbody>
                                  {tbl.rows?.map((row, rIdx) => (
                                    <tr
                                      key={rIdx}
                                      style={{
                                        background: rIdx === 0 ? "var(--surface-2)" : "transparent",
                                        fontWeight: rIdx === 0 ? 600 : 400,
                                      }}
                                    >
                                      {row.map((cell, cIdx) => (
                                        <td
                                          key={cIdx}
                                          style={{
                                            border: "1px solid var(--line)",
                                            padding: "6px 10px",
                                            textAlign: "left",
                                          }}
                                        >
                                          {renderHighlightedText(cell, highlightPhrases)}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* 幻灯片底部的演讲备注抽屉 */}
                  {currentSlide.notes && (
                    <div className="ppt-slide-notes-tray">
                      <span>💬</span>
                      <div style={{ flex: 1 }}>
                        <b>演讲备注</b>：{renderHighlightedText(currentSlide.notes, highlightPhrases)}
                      </div>
                    </div>
                  )}

                  {/* 幻灯片底部页码指示条 */}
                  <div
                    style={{
                      padding: "6px 20px",
                      background: "var(--surface-2)",
                      borderTop: "1px solid var(--line-2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: "11px",
                      color: "var(--ink-4)",
                    }}
                  >
                    <span>百纳知识引擎 · 演示文档排版</span>
                    <span>
                      {currentSlide.page} / {slides.length}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ color: "var(--ink-3)", fontSize: "13px" }}>未找到幻灯片内容</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
