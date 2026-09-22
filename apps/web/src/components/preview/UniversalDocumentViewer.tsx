"use client";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { PptDeckViewer } from '@/components/preview/PptDeckViewer';
import { renderMarkdown, renderPlainText } from '@/lib/markdown';
import { loadXLSX } from '@/lib/xlsx-loader';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { errorMessage, apiMessage, asRecord, str, num } from '@/lib/errors';
import {
  extractCleanPhrases, rankPhrases, chunkAnchoredPhrases as computeChunkAnchoredPhrases,
} from '@/lib/citation-phrases';
import {
  fetchCompileTruth, fetchDocDetail, fetchDocFile, fetchPdfPreviewBlob, resolvePreviewIds,
} from '@/lib/preview-api';
import type {
  CompileTruthPayload, CompileTruthSource, DocChunk, DocDetail, PreviewTarget,
} from '@/types';

interface UniversalDocumentViewerProps {
  preview: PreviewTarget | null;
  onClose: () => void;
}

export function UniversalDocumentViewer({ preview, onClose }: UniversalDocumentViewerProps) {
  const snippet = (preview?.snippet || '').trim();
  const [activeTab, setActiveTab] = useState(preview?.initialTab || (snippet ? 'std_md' : 'raw')); // 'raw' | 'std_md' | 'parsed' | 'chunks' | 'meta'
  const [stdMdMode, setStdMdMode] = useState('rendered'); // 'rendered' | 'source'
  const [fullscreen, setFullscreen] = useState(false);
  const [docked, setDocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docData, setDocData] = useState<DocDetail | null>(null);
  const [compileTruth, setCompileTruth] = useState<CompileTruthPayload | null>(null);
  const [compileTruthLoading, setCompileTruthLoading] = useState(false);
  const [compileTruthError, setCompileTruthError] = useState('');
  const [rawBlob, setRawBlob] = useState<Blob | null>(null);
  const [rawBlobUrl, setRawBlobUrl] = useState('');
  const [pptPdfBlobUrl, setPptPdfBlobUrl] = useState('');
  const [pptPdfLoading, setPptPdfLoading] = useState(false);
  const [pptPdfError, setPptPdfError] = useState('');
  const [sheetsData, setSheetsData] = useState<{ names: string[]; active: string; rows: unknown[][] }>({ names: [], active: '', rows: [] });
  const [copied, setCopied] = useState(false);
  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const modalBodyRef = useRef<HTMLDivElement | null>(null);

  const kbId = preview?.kbId || preview?.kb;
  const docId = preview?.docId || preview?.documentId || preview?.id;
  const filename = preview?.title || docData?.document?.title || '原始文档';
  const ext = (filename.split('.').pop() || '').toLowerCase();

  const isWord = ext === 'docx' || ext === 'doc';
  const isPdf = ext === 'pdf';
  const isExcel = ext === 'xlsx' || ext === 'xls' || ext === 'csv';
  const isPpt = ext === 'pptx' || ext === 'ppt';
  const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
  const isText = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'py', 'sql', 'html'].includes(ext);

  // 提取引用中的关键匹配短语 —— 彻底清除 markdown 格式字符并按自然标点智能分句
  const cleanPhrases = useMemo<string[]>(() => {
    if (!snippet) return [];
    const boilerplate = new Set([
      '属性维度', '详细内容与背景数据', '可信度', '单位全称/简称',
      '机构性质与背景', '关键领导关切', '数字化/AI现状', '痛点维度',
      '具体表现与管理挑战', '影响程度', '第一板块', '第二板块', '第三板块',
      '目标单位全景画像', '行业全景及核心痛点', '详细内容', '背景数据'
    ]);

    // 1. 先清除所有内联 markdown 语法标记
    const cleanText = snippet
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/^\s*[\d-]+\.?\s+/gm, '')
      .replace(/^[>\s*-]+/gm, '');

    const docTitleClean = (preview?.title || '').replace(/\.[^.]+$/, '').trim();

    // 2. 按标点分句，同时保护时间格式（如 08:30）
    const parts = cleanText
      .split(/[\n。；;\t\r|，,]+/g)
      .flatMap((s) => s.split(/：(?!\d)|:(?!\d)/g))
      .map((s) => s.replace(/^[#\s\-*>`:|0-9.()（）]+/, '').replace(/[#\s\-*>`:|0-9.()（）]+$/, '').trim())
      .map((s) => s.replace(/[\s\t]+/g, ' '))
      .filter((s) => {
        if (!s || s.length < 3) return false;
        if (/^[0-9a-fA-F-]{20,}$/.test(s)) return false;
        if (/^第?\s*\d+\s*页$/.test(s)) return false;
        if (boilerplate.has(s)) return false;
        if (docTitleClean && s === docTitleClean) return false;
        return true;
      });

    return Array.from(new Set(parts));
  }, [snippet, preview?.title]);

  // 根据文档全文对 cleanPhrases 进行智能打分排序
  const rankedPhrases = useMemo<string[]>(() => {
    if (!cleanPhrases.length || !docData?.markdown_content) return cleanPhrases.slice(0, 12);
    const fullText = String(docData.markdown_content);
    const scored = cleanPhrases.map((phrase) => {
      const p = String(phrase || '').trim();
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const matches = fullText.match(new RegExp(escaped, 'gi')) || [];
      const count = matches.length;
      const firstPos = fullText.search(new RegExp(escaped, 'i'));

      const uniqueScore = count === 0 ? -1000 : (count === 1 ? 100 : 60 / count);
      const lengthScore = Math.min(p.length, 30);
      const positionScore = firstPos > 0 ? (firstPos / fullText.length) * 20 : 0;
      return { phrase: p, score: uniqueScore + lengthScore + positionScore, count, firstPos };
    }).filter((item) => item.count > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 15).map((item) => item.phrase);
  }, [cleanPhrases, docData?.markdown_content]);

  // 整块锚定高亮：检索命中的单位是"知识切片(chunk)"，而逐句匹配会把命中
  // 打散到全文各处、且常落在错误位置。这里先把引用片段归一化后与文档的
  // 知识切片逐一比对，锁定命中的那个切片，再以该切片自身的行/句作为高亮
  // 短语 —— 高亮自然聚集在整块内容上，而不是散落的句级碎片。
  const chunkAnchoredPhrases = useMemo<string[] | null>(() => {
    if (!snippet || !docData?.chunks || !docData.chunks.length) return null;
    const stripDecorations = (s: unknown): string => String(s || '')
      .replace(/\[上下文:[^\]]*\]/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/【第[^】]{1,6}】/g, '');
    const norm = (s: unknown) => stripDecorations(s).replace(/\s+/g, '').toLowerCase();
    const target = norm(snippet).slice(0, 400);
    if (target.length < 12) return null;

    let best: { content?: unknown } | null = null;
    let bestScore = 0;
    for (const chunk of docData.chunks as Array<{ content?: unknown }>) {
      const c = norm(chunk.content);
      if (!c) continue;
      let score = 0;
      if (c.includes(target)) {
        score = 2 + target.length / Math.max(1, c.length);
      } else {
        const w = Math.min(60, target.length);
        if (w >= 20) {
          for (let i = 0; i + w <= target.length; i += 20) {
            if (c.includes(target.slice(i, i + w))) {
              score = Math.max(score, 1 + w / target.length);
              break;
            }
          }
        }
      }
      if (score > bestScore) { bestScore = score; best = chunk; }
    }
    // 置信不足时不启用整块锚定，退回句级短语
    if (!best || bestScore < 0.8) return null;

    // 用命中切片自身的行/句生成高亮短语（保持切片内顺序），确保"整块都高亮"
    const lines = stripDecorations(best.content)
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[。！？；;])/))
      .map((line) => line
        .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^[#\s\-*>`:|0-9.()（）【】]+/, '')
        .replace(/[#\s\-*>`:|]+$/, '')
        .replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 6 && line.length <= 160);
    const unique = Array.from(new Set(lines));
    // 整块锚定切片覆盖不足（如仅命中表格注入等非常规内容）时退回句级短语
    return unique.length >= 2 ? unique.slice(0, 60) : null;
  }, [snippet, docData?.chunks]);

  // 最终高亮短语：整块锚定优先 → 全文唯一性打分 → 原始清洗短语
  const highlightPhrases = useMemo<string[]>(() => {
    if (chunkAnchoredPhrases && chunkAnchoredPhrases.length) return chunkAnchoredPhrases;
    if (rankedPhrases.length) return rankedPhrases;
    return cleanPhrases;
  }, [chunkAnchoredPhrases, rankedPhrases, cleanPhrases]);

  useEffect(() => {
    if (!kbId || !docId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    setCompileTruth(null);
    setCompileTruthError('');
    setCompileTruthLoading(true);

    // Compile Truth is deliberately read from the current user's BrainTopic
    // and the authorized 百纳 source mapping, not inferred from UI status.
    fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/compile-truth`, { headers: apiHeaders() })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || `API ${res.status}`);
        return json;
      })
      .then((data) => { if (active) setCompileTruth(data); })
      .catch((err: unknown) => { if (active) setCompileTruthError(errorMessage(err) || '编译真相加载失败'); })
      .finally(() => { if (active) setCompileTruthLoading(false); });

    // 1. 获取文档元数据与分块数据
    fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}`, { headers: apiHeaders() })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || `API ${res.status}`);
        return json;
      })
      .then(async (data) => {
        if (!active) return;
        setDocData(data);

        // 2. 如果存在原始文件二进制，获取 Blob
        if (data.document?.hasRawFile) {
          try {
            const fileRes = await fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/file`, {
              headers: apiHeaders(),
            });
            if (fileRes.ok) {
              const blob = await fileRes.blob();
              if (active) {
                setRawBlob(blob);
                const url = URL.createObjectURL(blob);
                setRawBlobUrl(url);

                if (isExcel) {
                  const buffer = await blob.arrayBuffer();
                  const XLSX = await loadXLSX();
                  const wb = XLSX.read(buffer, { type: 'array' });
                  if (wb.SheetNames.length > 0) {
                    const firstSheet = wb.SheetNames[0];
                    const rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 }) as unknown[][];
                    setSheetsData({ names: wb.SheetNames, active: firstSheet, rows });
                  }
                }
              }
            }
          } catch (e) {
            console.warn('获取原始文件失败:', e);
          }
        }

        // 3. 如果是 PPT/PPTX，调用后端无损转制原生 PDF 真实版式预览
        if (isPpt && data.document?.hasRawFile) {
          setPptPdfLoading(true);
          setPptPdfError('');
          fetch(`${API_BASE_URL}/api/v1/kbs/${kbId}/documents/${docId}/pdf-preview`, {
            headers: apiHeaders(),
          })
            .then(async (res) => {
              if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                throw new Error(errJson.message || `API ${res.status}`);
              }
              return res.blob();
            })
            .then((blob) => {
              if (active) {
                const url = URL.createObjectURL(blob);
                setPptPdfBlobUrl(url);
              }
            })
            .catch((err: unknown) => {
              if (active) setPptPdfError(errorMessage(err) || 'PPT 原件预览生成中');
            })
            .finally(() => {
              if (active) setPptPdfLoading(false);
            });
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err) || '加载文档失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (rawBlobUrl) URL.revokeObjectURL(rawBlobUrl);
      if (pptPdfBlobUrl) URL.revokeObjectURL(pptPdfBlobUrl);
    };
  }, [kbId, docId]);

  // 高亮处理后的 Markdown HTML
  const markdownHtml = useMemo(() => {
    const content = docData?.markdown_content || '';
    return renderMarkdown(content, highlightPhrases);
  }, [docData?.markdown_content, highlightPhrases]);

  // 命中切片计算
  const chunkMatches = useMemo(() => {
    if (!docData?.chunks || !docData.chunks.length) return new Set<string>();
    const matched = new Set<string>();
    const phrases = highlightPhrases;
    (docData.chunks as DocChunk[]).forEach((chunk: DocChunk) => {
      const text = chunk.content || '';
      if (phrases.some((p) => {
        const escaped = String(p || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return new RegExp(escaped, 'i').test(text);
      })) {
        matched.add(chunk.id);
      }
    });
    if (matched.size === 0 && snippet && docData.chunks.length > 0) {
      const firstMatch = (docData.chunks as DocChunk[]).find((c: DocChunk) => (c.content || '').includes(snippet.slice(0, 15)));
      if (firstMatch) matched.add(firstMatch.id);
    }
    return matched;
  }, [docData?.chunks, highlightPhrases, snippet]);

  // 自动滚动定位到高亮最密集的区域
  useEffect(() => {
    if (!snippet) return;
    const executeScroll = () => {
      if (activeTab === 'parsed' || activeTab === 'std_md' || activeTab === 'raw') {
        const marks = modalBodyRef.current?.querySelectorAll('mark.doc-citation-highlight');
        if (!marks || marks.length === 0) return;
        if (marks.length === 1) {
          marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        // 找到最密集的高亮聚集区：在 350px 窗口内包含最多 mark 的位置
        let bestMark = marks[0];
        let bestCount = 0;
        const positions = Array.from(marks).map((m: Element) => ({ el: m, top: m.getBoundingClientRect().top }));
        for (let i = 0; i < positions.length; i++) {
          let count = 0;
          for (let j = i; j < positions.length && positions[j].top - positions[i].top < 350; j++) {
            count++;
          }
          if (count > bestCount) {
            bestCount = count;
            bestMark = positions[i].el;
          }
        }
        bestMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (activeTab === 'chunks') {
        const target = modalBodyRef.current?.querySelector('.chunk-card.matching-target');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    };

    const timer1 = setTimeout(executeScroll, 200);
    const timer2 = setTimeout(executeScroll, 500);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [activeTab, docData, rawBlobUrl, snippet, rankedPhrases]);

  // 3. 当处于原文档 Tab 且为 Word 时，调用 docx-preview
  useEffect(() => {
    if (activeTab !== 'raw' || !isWord || !rawBlob || !docxContainerRef.current) return;
    let disposed = false;
    (async () => {
      try {
        if (ext === 'docx') {
          const { renderAsync } = await import('docx-preview');
          if (disposed || !docxContainerRef.current) return;
          docxContainerRef.current.innerHTML = '';
          await renderAsync(rawBlob, docxContainerRef.current, undefined, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            className: 'docx',
          });
        } else {
          // .doc 格式直接采用 Docling 高保真 Markdown 渲染
          if (!disposed && docxContainerRef.current) {
            docxContainerRef.current.innerHTML = `<div style="background:var(--surface-2);padding:6px 12px;border-radius:6px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;border:1px solid var(--line);">💡 该文件为 Word 早期格式 (.doc)，已自动调用 Docling 智能版面引擎还原标准排版。</div><div class="parsed-markdown-view">${markdownHtml}</div>`;
          }
        }
      } catch (err) {
        console.warn('docx-preview 渲染异常，降级至 Docling Markdown:', err);
        if (!disposed && docxContainerRef.current) {
          docxContainerRef.current.innerHTML = `<div style="background:var(--surface-2);padding:6px 12px;border-radius:6px;font-size:11.5px;color:var(--ink-3);margin-bottom:16px;border:1px solid var(--line);">💡 已通过 Docling 高性能版面引擎还原标准格式。</div><div class="parsed-markdown-view">${markdownHtml}</div>`;
        }
      }
    })();
    return () => { disposed = true; };
  }, [activeTab, isWord, rawBlob, ext, markdownHtml]);

  const handleSheetChange = async (sheetName: string) => {
    if (!rawBlob) return;
    try {
      const XLSX = await loadXLSX();
      const buffer = await rawBlob.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 }) as unknown[][];
      setSheetsData((prev) => ({ ...prev, active: sheetName, rows }));
    } catch (e) {
      console.warn('切换 Sheet 失败:', e);
    }
  };

  const handleCopyMarkdown = () => {
    const text = docData?.markdown_content || '';
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    window.dispatchEvent(new CustomEvent('app-toast', { detail: '文档 Markdown 全文已复制到剪贴板' }));
  };

  const handleDownload = () => {
    if (!rawBlobUrl && !rawBlob) return;
    const a = document.createElement('a');
    a.href = rawBlobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatBadgeColor = isWord ? '#2563eb' : isPdf ? '#dc2626' : isExcel ? '#16a34a' : isPpt ? '#ea580c' : '#d97706';

  return (
    <div className={`modal-mask ${docked ? 'docked-mask' : ''}`} onClick={onClose} style={{ zIndex: 9999 }}>
      <div
        className={`modal preview-modal ${fullscreen ? 'fullscreen' : ''} ${docked ? 'docked' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题与导航栏 */}
        <div className="modal-head" style={{ padding: '12px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: '10.5px',
                fontWeight: 700,
                textTransform: 'uppercase',
                background: formatBadgeColor,
                color: '#fff',
                padding: '2px 6px',
                borderRadius: '4px',
                letterSpacing: '0.5px',
                flexShrink: 0
              }}
            >
              {ext || 'DOC'}
            </span>
            <h3 style={{ margin: 0, fontSize: '14.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filename}>
              {filename}
            </h3>
            {docked && (
              <span className="dock-hint-badge" title="分屏对比模式已启用，左侧页面可照常浏览并操作">
                ◫ 分屏对照模式
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
            {rawBlob && (
              <button
                type="button"
                className="btn"
                onClick={handleDownload}
                style={{ padding: '4px 10px', fontSize: '11.5px', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                title="下载原文件"
              >
                <span>📥</span> 下载原件
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={handleCopyMarkdown}
              style={{ padding: '4px 10px', fontSize: '11.5px', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title="复制 Markdown 全文"
            >
              <span>{copied ? '✓' : '📋'}</span> {copied ? '已复制' : '复制全文'}
            </button>
            <button
              type="button"
              className={`icon-btn ${docked ? 'active' : ''}`}
              onClick={() => {
                setDocked((d) => !d);
                if (fullscreen) setFullscreen(false);
              }}
              style={{ width: '28px', height: '28px', fontSize: '13px' }}
              title={docked ? '还原为居中弹窗' : '靠右分屏对照 (Dual Canvas)'}
            >
              ◫
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setFullscreen(!fullscreen);
                if (docked) setDocked(false);
              }}
              style={{ width: '28px', height: '28px', fontSize: '13px' }}
              title={fullscreen ? '退出全屏' : '全屏预览'}
            >
              {fullscreen ? '⛷' : '⛶'}
            </button>
            <span className="x" onClick={onClose} style={{ marginLeft: '4px' }}>×</span>
          </div>
        </div>

        {/* 次级 Tab 栏 */}
        <div className="preview-nav">
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'raw' ? 'active' : ''}`}
            onClick={() => setActiveTab('raw')}
          >
            <span>{isPpt ? '📽️' : '📄'}</span> {isPpt ? '原始幻灯片排版' : '原始文件排版'} {rawBlob ? '' : '(无原件)'}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'std_md' ? 'active' : ''}`}
            onClick={() => setActiveTab('std_md')}
          >
            <span>📝</span> 标准化 Markdown 页 {cleanPhrases.length > 0 ? '✨' : ''}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'parsed' ? 'active' : ''}`}
            onClick={() => setActiveTab('parsed')}
          >
            <span style={{display:'inline-flex',verticalAlign:'middle',marginRight:6}}><Icon name="share" size={12}/></span>标准化解析视图
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'chunks' ? 'active' : ''}`}
            onClick={() => setActiveTab('chunks')}
          >
            <span>🧩</span> 知识切片与向量 ({docData?.chunks?.length || docData?.document?.chunkCount || 0}) {chunkMatches.size > 0 ? `(命中 ${chunkMatches.size})` : ''}
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'truth' ? 'active' : ''}`}
            onClick={() => setActiveTab('truth')}
            title="查看当前用户的百纳编译状态、source 同步状态和最近编译记录"
          >
            <span>✅</span> Compile Truth
          </button>
          <button
            type="button"
            className={`preview-tab-btn ${activeTab === 'meta' ? 'active' : ''}`}
            onClick={() => setActiveTab('meta')}
          >
            <span style={{display:'inline-flex',verticalAlign:'middle',marginRight:6}}><Icon name="setting" size={12}/></span>元数据属性
          </button>

          <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--ink-4)' }}>
            {docData?.markdown_content ? `${docData.markdown_content.length} 字符 · ` : ''}
            {docData?.document?.status === 'published' ? '✓ 已发布' : docData?.document?.status || '就绪'}
          </div>
        </div>

        {/* 引用溯源快速跳转与高亮指示条 */}
        {snippet && (
          <div className="citation-jump-banner">
            <div className="banner-left">
              <span className="banner-badge">🎯 问答引用溯源</span>
              <span className="banner-text" title={snippet}>
                已为您高亮匹配原文与切片：“{snippet.replace(/\s+/g, ' ').slice(0, 48)}...”
                {preview?.pageNo ? ` · 命中第 ${preview.pageNo} 页` : ''}
                {preview?.bbox ? ` · 视口坐标 [X:${preview.bbox.x} Y:${preview.bbox.y}]` : ''}
              </span>
            </div>
            <div className="banner-actions">
              <button
                type="button"
                className={`jump-btn ${activeTab === 'raw' ? 'active' : ''}`}
                onClick={() => setActiveTab('raw')}
                title="查看原文排版"
              >
                📄 原始文件
              </button>
              <button
                type="button"
                className={`jump-btn ${activeTab === 'std_md' ? 'active' : ''}`}
                onClick={() => setActiveTab('std_md')}
                title="查看标准化 Markdown 知识页"
              >
                📝 标准化 Markdown (已高亮)
              </button>
              <button
                type="button"
                className={`jump-btn ${activeTab === 'chunks' ? 'active' : ''}`}
                onClick={() => setActiveTab('chunks')}
                title="定位命中切片"
              >
                🧩 命中切片 ({chunkMatches.size || 1})
              </button>
            </div>
          </div>
        )}

        {/* 预览主体内容区 */}
        <div className="modal-body" ref={modalBodyRef} style={{ position: 'relative' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '380px', gap: '12px' }}>
              <div className="streaming-dot" style={{ width: '12px', height: '12px', background: 'var(--evidence)' }} />
              <div style={{ fontSize: '13px', color: 'var(--ink-3)' }}>正在调集前端组件渲染文档与知识切片…</div>
            </div>
          ) : error ? (
            <div style={{ padding: '24px 20px', maxWidth: '840px', margin: '0 auto' }}>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '12.5px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>💡</span>
                <span><b>历史文档已更迭或删除</b>：该引用所属的物理原件近期可能已被更迭或删除（{error}）。以下为您展示该次问答时的真实引用切片：</span>
              </div>
              {snippet && (
                <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', padding: '16px 20px', borderRadius: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.7', fontSize: '13px', color: 'var(--ink)' }}>
                  {snippet}
                </div>
              )}
            </div>
          ) : (
            <div className="preview-content-area">
              {/* Tab 1: 原文档排版 */}
              {activeTab === 'raw' && (
                <>
                  {isWord && rawBlob ? (
                    <div className="docx-render-container" ref={docxContainerRef}>
                      <div style={{ textAlign: 'center', padding: '30px', color: 'var(--ink-3)' }}>Word 文档渲染中…</div>
                    </div>
                  ) : isPdf && rawBlobUrl ? (
                    <div style={{ width: '100%', height: '100%', minHeight: '72vh', display: 'flex', flexDirection: 'column', gap: '8px', position: 'relative' }}>
                      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink-3)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span>📄</span>
                          <span><b>PDF 原件内嵌预览</b>{preview?.pageNo ? `（已自动定位至第 ${preview.pageNo} 页）` : '（支持缩放、打印与页码定位）'}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <a href={preview?.pageNo ? `${rawBlobUrl}#page=${preview.pageNo}` : rawBlobUrl} target="_blank" rel="noreferrer" className="btn" style={{ padding: '3px 8px', fontSize: '11px', height: '24px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>新窗口打开 ↗</a>
                          <button type="button" className="btn" onClick={() => setActiveTab('std_md')} style={{ padding: '3px 8px', fontSize: '11px', height: '24px' }}>查看结构化 Markdown</button>
                        </div>
                      </div>
                      <iframe
                        src={preview?.pageNo ? `${rawBlobUrl}#page=${preview.pageNo}&toolbar=1` : `${rawBlobUrl}#toolbar=1`}
                        title={filename}
                        style={{ width: '100%', flex: 1, minHeight: '68vh', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}
                      />
                      {preview?.bbox && (
                        <div style={{
                          position: 'absolute',
                          bottom: '16px',
                          right: '20px',
                          background: 'rgba(234, 88, 12, 0.95)',
                          color: '#fff',
                          padding: '6px 14px',
                          borderRadius: '6px',
                          fontSize: '11.5px',
                          fontWeight: 600,
                          boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          zIndex: 10,
                          pointerEvents: 'none',
                        }}>
                          <span>🎯 像素级视觉锚点: 第 {preview.pageNo || 1} 页 [X:{preview.bbox.x} Y:{preview.bbox.y} 宽:{preview.bbox.w} 高:{preview.bbox.h}]</span>
                        </div>
                      )}
                    </div>
                  ) : isExcel && sheetsData.names.length > 0 ? (
                    <div className="sheet-container">
                      <div className="sheet-tabs">
                        {sheetsData.names.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className={`sheet-tab-btn ${sheetsData.active === name ? 'active' : ''}`}
                            onClick={() => handleSheetChange(name)}
                          >
                            📊 {name}
                          </button>
                        ))}
                      </div>
                      <div className="sheet-table-wrap">
                        <table>
                          <tbody>
                            {sheetsData.rows.map((row: unknown[], rIdx: number) => (
                              <tr key={rIdx}>
                                {row.map((cell: unknown, cIdx: number) => (
                                  rIdx === 0 ? (
                                    <th key={cIdx}>{String(cell ?? '')}</th>
                                  ) : (
                                    <td key={cIdx}>{String(cell ?? '')}</td>
                                  )
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : isPpt ? (
                    pptPdfBlobUrl ? (
                      <div style={{ width: '100%', height: '100%', minHeight: '72vh', display: 'flex', flexDirection: 'column', gap: '8px', position: 'relative' }}>
                        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '6px', padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink-3)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span>📽️</span>
                            <span><b>PPT 原版演示文稿真实预览</b>{preview?.pageNo ? `（已自动定位至第 ${preview.pageNo} 页）` : '（100% 还原原版排版、母版设计、图表与幻灯片画幅）'}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <a href={preview?.pageNo ? `${pptPdfBlobUrl}#page=${preview.pageNo}` : pptPdfBlobUrl} target="_blank" rel="noreferrer" className="btn" style={{ padding: '3px 8px', fontSize: '11px', height: '24px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>新窗口打开 ↗</a>
                            <button type="button" className="btn" onClick={() => setActiveTab('std_md')} style={{ padding: '3px 8px', fontSize: '11px', height: '24px' }}>查看结构化 Markdown</button>
                          </div>
                        </div>
                        <iframe
                          src={preview?.pageNo ? `${pptPdfBlobUrl}#page=${preview.pageNo}&toolbar=1` : `${pptPdfBlobUrl}#toolbar=1`}
                          title={filename}
                          style={{ width: '100%', flex: 1, minHeight: '68vh', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}
                        />
                      </div>
                    ) : pptPdfLoading ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '380px', gap: '12px' }}>
                        <div className="streaming-dot" style={{ width: '14px', height: '14px', background: '#ea580c' }} />
                        <div style={{ fontSize: '13px', color: 'var(--ink-3)' }}>正在生成 PPT 原版母版排版与幻灯片预览…</div>
                      </div>
                    ) : (
                      <PptDeckViewer
                        rawBlob={rawBlob}
                        rawBlobUrl={rawBlobUrl}
                        docData={docData}
                        filename={filename}
                        ext={ext}
                        preview={preview}
                        highlightPhrases={highlightPhrases}
                        onSwitchToMd={() => setActiveTab('std_md')}
                      />
                    )
                  ) : isImage && rawBlobUrl ? (
                    <div style={{ textAlign: 'center', padding: '20px' }}>
                      <img src={rawBlobUrl} alt={filename} style={{ maxWidth: '100%', maxHeight: '72vh', borderRadius: '8px', boxShadow: 'var(--shadow-md)' }} />
                    </div>
                  ) : (
                    /* 兜底渲染为结构化 Markdown */
                    <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
                  )}
                </>
              )}

              {/* Tab 2: 标准化 Markdown 知识页 */}
              {activeTab === 'std_md' && (
                <div style={{ maxWidth: '920px', width: '100%', margin: '0 auto' }}>
                  <div className="std-md-banner">
                    <div className="std-md-banner-info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="std-md-path-badge">📄 {docData?.document?.mdPath || `${docId}/content.md`}</span>
                        <span style={{ fontSize: '11px', color: 'var(--ink-4)' }}>Git 版本受控 · Single Source of Truth</span>
                      </div>
                      <div className="std-md-desc">
                        💡 这是从原始多模态文档解析提炼的<b>标准化 Markdown 知识页</b>。已剔除冗余版式噪声并完整保留多级标题、数据表格与实体关系，作为知识切片构建与大模型动态问答的语义真实源。
                      </div>
                    </div>
                    <div className="std-md-controls">
                      <div className="sheet-tabs" style={{ background: 'transparent', border: 'none', padding: 0 }}>
                        <button
                          type="button"
                          className={`sheet-tab-btn ${stdMdMode === 'rendered' ? 'active' : ''}`}
                          onClick={() => setStdMdMode('rendered')}
                        >
                          🎨 渲染排版
                        </button>
                        <button
                          type="button"
                          className={`sheet-tab-btn ${stdMdMode === 'source' ? 'active' : ''}`}
                          onClick={() => setStdMdMode('source')}
                        >
                          💻 源码视图
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={handleCopyMarkdown}
                        style={{ padding: '4px 8px', fontSize: '11px', height: '26px' }}
                        title="复制 Markdown 源码"
                      >
                        {copied ? '✓ 已复制' : '📋 复制源码'}
                      </button>
                    </div>
                  </div>

                  {stdMdMode === 'rendered' ? (
                    <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
                  ) : (
                    <pre className="markdown-source-container"><code>{docData?.markdown_content || '暂无内容'}</code></pre>
                  )}
                </div>
              )}

              {/* Tab 3: Docling Markdown 解析视图 */}
              {activeTab === 'parsed' && (
                <div className="parsed-markdown-view" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
              )}

              {/* Tab 4: 知识切片与向量 */}
              {activeTab === 'chunks' && (
                <div className="chunks-grid">
                  <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginBottom: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>标准化分块结果 · 共 {docData?.chunks?.length || 0} 个切片 · 细粒度父子关联</span>
                    {chunkMatches.size > 0 && <span style={{ color: 'var(--evidence)', fontWeight: 600 }}>🎯 命中 {chunkMatches.size} 个问答切片</span>}
                  </div>
                  {docData?.chunks && docData.chunks.length > 0 ? (
                    (docData.chunks as DocChunk[]).map((chunk: DocChunk, idx: number) => {
                      const isMatch = chunkMatches.has(chunk.id);
                      return (
                        <div key={chunk.id || idx} className={`chunk-card ${isMatch ? 'matching-target' : ''}`}>
                          <div className="chunk-card-head">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '11px', fontWeight: 600, color: isMatch ? '#fff' : 'var(--evidence)', background: isMatch ? 'var(--evidence)' : 'var(--evidenceSoft)', padding: '1px 6px', borderRadius: '4px' }}>
                                #{chunk.ord ?? idx + 1}
                              </span>
                              {isMatch && <span className="chunk-match-badge">🎯 问答引用命中切片</span>}
                              <span style={{ fontSize: '11.5px', color: 'var(--ink-3)' }}>
                                切片 ID: {chunk.id ? chunk.id.slice(0, 8) + '...' : `chunk-${idx}`}
                              </span>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--ink-4)' }}>
                              {chunk.tokenCount ? `${chunk.tokenCount} tokens · ` : ''}{chunk.content?.length || 0} 字
                            </span>
                          </div>
                          <div style={{ fontSize: '12.5px', color: 'var(--ink)', lineHeight: '1.6', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                            {isMatch ? (
                              <span dangerouslySetInnerHTML={{
                                __html: renderPlainText(chunk.content || '', highlightPhrases)
                              }} />
                            ) : (
                              chunk.content
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ padding: '30px', textAlign: 'center', color: 'var(--ink-3)' }}>
                      暂无切片详情
                    </div>
                  )}
                </div>
              )}

              {/* Tab 5: 当前用户的 百纳 Compile Truth */}
              {activeTab === 'truth' && (
                <div style={{ maxWidth: '900px', width: '100%', margin: '0 auto' }}>
                  <div style={{ padding: '16px 18px', borderRadius: '10px', border: '1px solid var(--line)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '16px' }}>
                      <div>
                        <div style={{ fontSize: '15px', fontWeight: 650, color: 'var(--ink)' }}>Compile Truth · 编译真相</div>
                        <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '5px', lineHeight: 1.6 }}>
                          这里展示当前登录用户实际可用的百纳 topic 与 source 状态。数据库权限校验仍是最终准入条件。
                        </div>
                      </div>
                      {compileTruth?.compileTruth?.state && (
                        <span className={`badge ${compileTruth?.compileTruth?.state === 'clean' ? 'ok' : compileTruth?.compileTruth?.state === 'not_created' ? 'indexing' : 'warn'}`}>
                          {compileTruth?.compileTruth?.state === 'clean' ? '✓ 已编译' : compileTruth?.compileTruth?.state === 'not_created' ? '尚未生成 Topic' : compileTruth?.compileTruth?.state}
                        </span>
                      )}
                    </div>
                    {compileTruthLoading ? (
                      <div style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '24px 0' }}>正在读取当前用户的 Compile Truth…</div>
                    ) : compileTruthError ? (
                      <div style={{ color: 'var(--danger)', fontSize: '12px', padding: '12px 0' }}>{compileTruthError}</div>
                    ) : compileTruth?.document ? (
                      <>
                        <div className="perm-list" style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '10px 16px', fontSize: '12px' }}>
                          <div style={{ color: 'var(--ink-3)' }}>Topic</div><div><code>{compileTruth?.compileTruth?.topicSlug}</code></div>
                          <div style={{ color: 'var(--ink-3)' }}>Topic 文件</div><div><code>{compileTruth?.compileTruth?.mdPath || '—'}</code></div>
                          <div style={{ color: 'var(--ink-3)' }}>最后编译时间</div><div>{compileTruth?.compileTruth?.lastCompiledAt ? new Date(compileTruth?.compileTruth?.lastCompiledAt).toLocaleString('zh-CN') : '—'}</div>
                          <div style={{ color: 'var(--ink-3)' }}>BrainRepo 最后编译</div><div>{compileTruth?.compileTruth?.brainRepoLastCompileAt ? new Date(compileTruth?.compileTruth?.brainRepoLastCompileAt).toLocaleString('zh-CN') : '—'}</div>
                          <div style={{ color: 'var(--ink-3)' }}>当前文档</div><div>{compileTruth?.document?.status} · {compileTruth?.document?.chunkCount} 个检索 Chunk · v{compileTruth?.document?.version}</div>
                        </div>
                        <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--line)' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>百纳 source 同步记录</div>
                          {compileTruth?.compileTruth?.sources?.length ? (compileTruth.compileTruth?.sources || []).map((source: CompileTruthSource) => (
                            <div key={source.sourceKey} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '5px 16px', padding: '10px 12px', marginBottom: '7px', borderRadius: '7px', background: 'var(--surface-2)' }}>
                              <div><code>{source.sourceKey}</code> <span style={{ color: 'var(--ink-3)', marginLeft: '6px' }}>{source.kind === 'shared' ? '共享 source' : '权限组 source'}</span></div>
                              <span className="badge ok">已同步 v{source.syncedVersion}</span>
                              <div style={{ gridColumn: '1 / -1', color: 'var(--ink-3)', fontSize: '11px' }}>文档同步：{source.syncedAt ? new Date(source.syncedAt).toLocaleString('zh-CN') : '—'} · source 最近同步：{source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString('zh-CN') : '—'}</div>
                            </div>
                          )) : <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>当前用户还没有可见 source 的同步记录。</div>}
                        </div>
                        {compileTruth?.compileTruth?.latestJob && (
                          <div style={{ marginTop: '14px', color: 'var(--ink-3)', fontSize: '11px' }}>
                            最近编译任务：{compileTruth?.compileTruth?.latestJob.trigger} · {compileTruth?.compileTruth?.latestJob.status} · {compileTruth?.compileTruth?.latestJob.completedAt ? new Date(compileTruth?.compileTruth?.latestJob.completedAt).toLocaleString('zh-CN') : '进行中'}
                          </div>
                        )}
                      </>
                    ) : compileTruth ? (
                      <div style={{ color: 'var(--ink-3)', fontSize: '12px', padding: '24px 0' }}>
                        当前文档尚未生成可展示的 Compile Truth。
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Tab 6: 元数据属性 */}
              {activeTab === 'meta' && (
                <div style={{ maxWidth: '780px', width: '100%', margin: '0 auto', background: 'var(--surface)', padding: '24px', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <h4 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>文档系统元数据</h4>
                  <div className="perm-list" style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '10px 16px', fontFamily: 'inherit', fontSize: '12px' }}>
                    <div style={{ color: 'var(--ink-3)' }}>文档标识 (ID)</div>
                    <div><code>{docData?.document?.id || docId}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>标准化 Markdown 路径</div>
                    <div><code>{docData?.document?.mdPath || `${docId}/content.md`}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>所属知识库</div>
                    <div><code>{docData?.document?.kbId || kbId}</code></div>

                    <div style={{ color: 'var(--ink-3)' }}>文档标题</div>
                    <div style={{ fontWeight: 500 }}>{filename}</div>

                    <div style={{ color: 'var(--ink-3)' }}>索引状态</div>
                    <div><span className={`badge ${docData?.document?.status === 'published' ? 'ok' : 'indexing'}`}>{docData?.document?.status || '就绪'}</span></div>

                    <div style={{ color: 'var(--ink-3)' }}>解析引擎 / 文档类型</div>
                    <div>{docData?.document?.parserEngine || '—'}{docData?.document?.parserClassification ? ` · ${docData.document.parserClassification}` : ''}</div>

                    <div style={{ color: 'var(--ink-3)' }}>入库质量门禁</div>
                    <div>{docData?.document?.qualityStatus || 'unknown'}{typeof docData?.document?.qualityScore === 'number' ? ` · ${(docData.document.qualityScore * 100).toFixed(1)} 分` : ''}{Array.isArray(docData?.document?.qualityIssues) && docData.document.qualityIssues.length ? ` · ${docData.document.qualityIssues.join('；')}` : ''}</div>

                    <div style={{ color: 'var(--ink-3)' }}>切片总数</div>
                    <div>{docData?.document?.chunkCount || docData?.chunks?.length || 0} 个检索 Chunk</div>

                    <div style={{ color: 'var(--ink-3)' }}>原始二进制</div>
                    <div>{docData?.document?.hasRawFile ? '✓ 存在已归档原文件' : '— 纯文本直接录入'}</div>

                    <div style={{ color: 'var(--ink-3)' }}>创建时间</div>
                    <div>{docData?.document?.createdAt ? new Date(docData.document.createdAt).toLocaleString('zh-CN') : '—'}</div>

                    <div style={{ color: 'var(--ink-3)' }}>最后更新</div>
                    <div>{docData?.document?.updatedAt ? new Date(docData.document.updatedAt).toLocaleString('zh-CN') : '—'}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  );
}

export function OnlinePreviewModal({ preview, onClose }: { preview: PreviewTarget | null; onClose: () => void }) {
  if (!preview) return null;
  return <UniversalDocumentViewer preview={preview} onClose={onClose} />;
}

