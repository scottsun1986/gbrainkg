import React, { useState, useEffect, useRef, useMemo } from 'react';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { Icon } from '@/app/page';

/* ============== 知识图谱（Obsidian 风格力导向布局） ============== */

export function runForceLayout(nodes: any[], edges: any[], options?: any) {
  const opts = options || {};
  const width = opts.width ?? 900;
  const height = opts.height ?? 600;
  const chargeStrength = opts.chargeStrength ?? -380;
  const linkDistance = opts.linkDistance ?? 60;
  const iterations = opts.iterations ?? 600;
  const N = nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  const radiusFor = (n: any) => (n.type === 'knowledge_base' ? 18 : n.type === 'document' ? 12 : 8);
  const pos = nodes.map((_, i) => {
    const ratio = (i + 0.5) / Math.max(N, 1);
    const ring = Math.floor(Math.sqrt(ratio) * Math.sqrt(N));
    const angle = ratio * Math.PI * 2 * 4;
    const r = ring * Math.min(width, height) * 0.04 + 20;
    return {
      x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 8,
      y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 8,
      fx: 0,
      fy: 0,
    };
  });
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = Math.max(0.04, 1 - iter / iterations);
    for (let i = 0; i < N; i++) {
      pos[i].fx = (cx - pos[i].x) * 0.012 * alpha;
      pos[i].fy = (cy - pos[i].y) * 0.012 * alpha;
    }
    for (let i = 0; i < N; i++) {
      const a = pos[i]; const aNode = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = pos[j]; const bNode = nodes[j];
        let dx = a.x - b.x; let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy; if (dist2 < 1) { dist2 = 1; dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); }
        const dist = Math.max(Math.sqrt(dist2), 0.1);
        const repulseForce = (Math.abs(chargeStrength) / (dist2 + 40)) * alpha;
        const fx = (dx / dist) * repulseForce; const fy = (dy / dist) * repulseForce;
        a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy;
        const minDist = radiusFor(aNode) + radiusFor(bNode) + 12;
        if (dist < minDist) {
          const push = (minDist - dist) / dist * 0.4 * alpha;
          a.fx += (dx / dist) * push * 10;
          a.fy += (dy / dist) * push * 10;
          b.fx -= (dx / dist) * push * 10;
          b.fy -= (dy / dist) * push * 10;
        }
      }
    }
    for (const e of edges) {
      const si = idx.get(e.source) as number | undefined; const ti = idx.get(e.target) as number | undefined;
      if (si == null || ti == null) continue;
      const a = pos[si]; const b = pos[ti];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = linkDistance + (e.type === 'contains' ? -8 : 0);
      const diff = (dist - target) / dist;
      const k = diff * 0.18 * alpha * (1 + Math.min(2, (e.weight || 1) * 0.1));
      a.fx += dx * k; a.fy += dy * k; b.fx -= dx * k; b.fy -= dy * k;
    }
    const damp = 0.2;
    for (let i = 0; i < N; i++) {
      const vx = Math.max(-15, Math.min(15, pos[i].fx * damp));
      const vy = Math.max(-15, Math.min(15, pos[i].fy * damp));
      pos[i].x += vx;
      pos[i].y += vy;
      pos[i].x = Math.max(60, Math.min(width - 60, pos[i].x));
      pos[i].y = Math.max(60, Math.min(height - 60, pos[i].y));
    }
  }
  return nodes.map((n, i) => ({ ...n, x: pos[i].x, y: pos[i].y }));
}

export function KnowledgeGraphScreen({ onOpenDocument, onOpenKb }: any){
  const [graph, setGraph] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [layout, setLayout] = useState<any>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [types, setTypes] = useState<Record<string, boolean>>({ knowledge_base: true, document: true, concept: true });
  const [localRoot, setLocalRoot] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [params, setParams] = useState({ charge: -320, link: 60, showLabels: 'auto' });

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<any>(null);
  const panRef = useRef<any>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1100, h: 720 });

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`${API_BASE_URL}/api/v1/knowledge-graph`, {headers: apiHeaders()})
      .then(async response => { const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.message || `API ${response.status}`); return payload; })
      .then(payload => { if (active) { setGraph(payload); setError(''); } })
      .catch(reason => { if (active) setError(reason.message || '知识图谱加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const allNodes = graph?.nodes || [];
  const allEdges = graph?.edges || [];

  const visibleIds = useMemo(() => {
    const ids = new Set();
    for (const n of allNodes) if (types[n.type]) ids.add(n.id);
    return ids;
  }, [allNodes, types]);

  const filteredNodes = useMemo(() => allNodes.filter((n: any) => visibleIds.has(n.id)), [allNodes, visibleIds]);
  const filteredEdges = useMemo(() => allEdges.filter((e: any) => visibleIds.has(e.source) && visibleIds.has(e.target)), [allEdges, visibleIds]);

  const focusNodes = useMemo(() => {
    if (!localRoot) return filteredNodes;
    const depthMap = new Map([[localRoot, 0]]);
    const adj = new Map();
    for (const e of filteredEdges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source).push(e.target);
      adj.get(e.target).push(e.source);
    }
    const queue = [localRoot];
    while (queue.length) {
      const cur = queue.shift();
      const d = depthMap.get(cur) || 0;
      if (d >= 2) continue;
      for (const next of adj.get(cur) || []) {
        if (!depthMap.has(next)) { depthMap.set(next, d + 1); queue.push(next); }
      }
    }
    return filteredNodes.filter((n: any) => depthMap.has(n.id));
  }, [filteredNodes, filteredEdges, localRoot]);

  const focusEdges = useMemo(() => {
    const ids = new Set(focusNodes.map((n: any) => n.id));
    return filteredEdges.filter((e: any) => ids.has(e.source) && ids.has(e.target));
  }, [focusNodes, filteredEdges]);

  const degreeMap = useMemo(() => {
    const m = new Map();
    for (const e of filteredEdges) { m.set(e.source, (m.get(e.source) || 0) + 1); m.set(e.target, (m.get(e.target) || 0) + 1); }
    return m;
  }, [filteredEdges]);

  useEffect(() => {
    const canvas = svgRef.current?.parentElement;
    if (!canvas) return undefined;
    const update = () => {
      if (canvas.clientWidth > 100 && canvas.clientHeight > 100) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        setCanvasSize((prev) => (Math.abs(prev.w - w) > 20 || Math.abs(prev.h - h) > 20) ? { w, h } : prev);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!graph || filteredNodes.length === 0) { setLayout(null); return; }
    const { w, h } = canvasSize;
    const t = setTimeout(() => {
      setLayout((prev: any) => {
        if (prev && localRoot === prev._root && filteredNodes.length === prev._count && prev._w === w && prev._h === h) {
          const sameParams = prev._charge === params.charge && prev._link === params.link;
          if (sameParams) return prev;
        }
        const positioned = runForceLayout(focusNodes, focusEdges, { width: w, height: h, chargeStrength: params.charge, linkDistance: params.link });
        requestAnimationFrame(() => {
          const xs = positioned.map((n: any) => n.x); const ys = positioned.map((n: any) => n.y);
          if (xs.length > 0) {
            const minX = Math.min(...xs); const maxX = Math.max(...xs);
            const minY = Math.min(...ys); const maxY = Math.max(...ys);
            const bboxW = Math.max(maxX - minX, 1); const bboxH = Math.max(maxY - minY, 1);
            const kx = (w - 80) / bboxW; const ky = (h - 80) / bboxH;
            const k = Math.min(1.8, Math.max(0.7, Math.min(kx, ky)));
            const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
            setTransform({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });
          }
        });
        return { nodes: positioned, _root: localRoot, _count: focusNodes.length, _charge: params.charge, _link: params.link, _w: w, _h: h };
      });
    }, 16);
    return () => clearTimeout(t);
  }, [focusNodes, focusEdges, graph, localRoot, params.charge, params.link, canvasSize.w, canvasSize.h]);

  const positions = useMemo(() => {
    const map = new Map();
    if (layout) for (const n of layout.nodes) map.set(n.id, { x: n.x, y: n.y });
    return map;
  }, [layout]);

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase(); if (!q) return null;
    const s = new Set<string>();
    for (const n of filteredNodes) if (n.label.toLowerCase().includes(q)) s.add(n.id);
    return s;
  }, [query, filteredNodes]);

  const hoverId = hovered || selected;
  const neighborIds = useMemo(() => {
    if (!hoverId) return null;
    const s = new Set([hoverId]);
    for (const e of filteredEdges) {
      if (e.source === hoverId) s.add(e.target);
      if (e.target === hoverId) s.add(e.source);
    }
    return s;
  }, [hoverId, filteredEdges]);

  const selectedNode = allNodes.find((n: any) => n.id === selected);
  const selectedEdges = selected ? allEdges.filter((e: any) => e.source === selected || e.target === selected) : [];
  const relatedByType = useMemo(() => {
    const groups: Record<string, any[]> = { contains: [], mentions: [], related_to: [] };
    for (const e of selectedEdges) {
      const key = e.type;
      const bucket = (groups[key] || (groups[key] = []));
      bucket.push(e);
    }
    return groups;
  }, [selectedEdges, selected]);

  const nodeColor: Record<string, string> = { knowledge_base: '#7c6cd9', document: '#4c7fd0', concept: '#c08a3e' };
  const labelText = (n: any) => n.label.length > 14 ? `${n.label.slice(0, 14)}…` : n.label;
  const nodeRadius = (n: any) => {
    const base = n.type === 'knowledge_base' ? 18 : n.type === 'document' ? 13 : 8;
    const deg = degreeMap.get(n.id) || 0;
    return base + Math.min(8, deg * 0.6);
  };
  const showLabel = (n: any) => {
    if (params.showLabels === 'always') return true;
    if (params.showLabels === 'off') return false;
    if (hoverId && neighborIds && neighborIds.has(n.id)) return true;
    if (matchIds && matchIds.has(n.id)) return true;
    return transform.k > 1.05;
  };
  const edgeActive = (e: any) => !hoverId || e.source === hoverId || e.target === hoverId;

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const cx = event.clientX - rect.left; const cy = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.3, Math.min(3.5, transform.k * factor));
    const ratio = next / transform.k;
    setTransform({ k: next, x: cx - (cx - transform.x) * ratio, y: cy - (cy - transform.y) * ratio });
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if ((event.target as Element).closest('.graph-node')) return;
    panRef.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
  };
  const onMouseMove = (event: React.MouseEvent) => {
    if (dragRef.current) {
      const d = dragRef.current;
      d.node.fx = d.node.x = d.startX + (event.clientX - d.startClientX) / transform.k;
      d.node.fy = d.node.y = d.startY + (event.clientY - d.startClientY) / transform.k;
      setLayout({ ...layout, nodes: [...layout.nodes] });
      return;
    }
    if (panRef.current) {
      setTransform({ ...transform, x: panRef.current.tx + (event.clientX - panRef.current.x), y: panRef.current.ty + (event.clientY - panRef.current.y) });
    }
  };
  const onMouseUp = () => { dragRef.current = null; panRef.current = null; };

  const startNodeDrag = (event: React.MouseEvent, node: any) => {
    event.stopPropagation();
    dragRef.current = { node, startX: node.x, startY: node.y, startClientX: event.clientX, startClientY: event.clientY };
  };
  const onNodeClick = (event: React.MouseEvent, node: any) => { event.stopPropagation(); setSelected(node.id); };
  const onNodeDouble = (event: React.MouseEvent, node: any) => {
    event.stopPropagation();
    if (node.type === 'document' && node.documentId && node.kbId) onOpenDocument?.(node.kbId, node.documentId, node.label);
    else if (node.type === 'knowledge_base' && node.kbId) onOpenKb?.(node.kbId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelected(null); setHovered(null); }
      if (event.key === 'f' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); (document.querySelector('.graph-search input') as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fitView = () => {
    setTransform({ x: 0, y: 0, k: 1.0 });
  };

  const resetView = () => { setTransform({ x: 0, y: 0, k: 1 }); };
  const rerunLayout = () => setLayout(null);

  const lastFitKey = useRef('');
  useEffect(() => {
    if (!layout) return;
    const key = `${layout._root || 'global'}:${layout._count}:${layout._w}x${layout._h}`;
    if (key !== lastFitKey.current) {
      lastFitKey.current = key;
      requestAnimationFrame(() => fitView());
    }
    const canvas = svgRef.current?.parentElement;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (canvas.clientWidth > 100) {
        fitView();
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [layout]);
  
  const centerOnSelected = () => {
    if (!selected || !positions.has(selected)) return;
    const p = positions.get(selected);
    const canvas = svgRef.current?.parentElement;
    if (canvas) {
      setTransform({ ...transform, x: canvas.clientWidth / 2 - p.x * transform.k, y: canvas.clientHeight / 2 - p.y * transform.k });
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { knowledge_base: 0, document: 0, concept: 0 };
    for (const n of filteredNodes) c[n.type] = (c[n.type] || 0) + 1;
    return c;
  }, [filteredNodes]);

  if (loading) return <div className="graph-page"><div className="graph-state">正在构建你的知识图谱…</div></div>;
  if (error) return <div className="graph-page"><div className="graph-state error">{error}</div></div>;

  return (
    <div className="graph-page">
      <div className="graph-head">
        <div>
          <div className="h1">知识图谱</div>
          <div className="subline">展示你有权访问的已发布知识 · 滚轮缩放、拖拽节点、悬停高亮邻居</div>
        </div>
        <div className="graph-stats">
          <span>{graph?.stats?.documents || 0} 文档</span>
          <span>{graph?.stats?.concepts || 0} 个主题</span>
          <span>{graph?.stats?.relations || 0} 条关系</span>
        </div>
      </div>

      <div className="graph-toolbar">
        <div className="graph-type-filter">
          {[
            { k: 'knowledge_base', l: '知识库', c: nodeColor.knowledge_base },
            { k: 'document', l: '文档', c: nodeColor.document },
            { k: 'concept', l: '主题', c: nodeColor.concept },
          ].map((t) => (
            <button
              key={t.k}
              type="button"
              className={`graph-type-chip ${types[t.k] ? 'on' : ''}`}
              onClick={() => setTypes({ ...types, [t.k]: !types[t.k] })}
              aria-pressed={types[t.k]}
            >
              <i style={{ background: t.c }} />
              <span>{t.l}</span>
              <em>{counts[t.k] || 0}</em>
            </button>
          ))}
        </div>
        <div className="graph-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档或主题（⌘F 聚焦）"
            onKeyDown={(event) => { if (event.key === 'Enter' && matchIds) { const first = [...matchIds][0]; if (first) setSelected(first); } }}
          />
          {matchIds && <span className="graph-search-hint">{matchIds.size} 命中</span>}
        </div>
        {localRoot && (
          <button type="button" className="graph-local-back" onClick={() => { setLocalRoot(null); setSelected(null); }}>
            ← 返回全局图谱
          </button>
        )}
        <div className="graph-toolbar-spacer" />
        <button type="button" className="graph-icon-btn" title="重新布局" onClick={rerunLayout}><Icon name="refresh" size={14} /></button>
        <button type="button" className="graph-icon-btn" title="适应视图" onClick={fitView}><Icon name="search" size={14} /></button>
        <button type="button" className={`graph-icon-btn ${showSettings ? 'on' : ''}`} title="显示设置" onClick={() => setShowSettings(!showSettings)}><Icon name="setting" size={14} /></button>
      </div>

      {showSettings && (
        <div className="graph-settings">
          <label>斥力强度 <input type="range" min="-400" max="-40" value={params.charge} onChange={(e) => setParams({ ...params, charge: Number(e.target.value) })} /></label>
          <label>连线距离 <input type="range" min="40" max="160" value={params.link} onChange={(e) => setParams({ ...params, link: Number(e.target.value) })} /></label>
          <label>标签显示
            <select value={params.showLabels} onChange={(e) => setParams({ ...params, showLabels: e.target.value })}>
              <option value="auto">自动（缩放时显示）</option>
              <option value="always">始终显示</option>
              <option value="off">始终隐藏</option>
            </select>
          </label>
        </div>
      )}

      <div className="graph-layout">
        <div className="graph-canvas" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
          {filteredNodes.length === 0 ? (
            <div className="graph-state">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 8 }}>当前没有可生成图谱的已发布知识</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>去「知识库」上传一份文档，发布后会自动出现在这里</div>
              </div>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="个人知识图谱"
              onWheel={onWheel as any}
              onMouseDown={onMouseDown as any}
              style={{ cursor: panRef.current ? 'grabbing' : 'grab' }}
            >
              <defs>
                <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#b9b5ae" />
                </marker>
              </defs>
              <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
                {focusEdges.map((edge: any) => {
                  const a = positions.get(edge.source); const b = positions.get(edge.target);
                  if (!a || !b) return null;
                  const active = edgeActive(edge);
                  const opacity = hoverId ? (active ? 0.85 : 0.05) : 0.6;
                  return (
                    <g key={edge.id} opacity={opacity}>
                      <line
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={edge.type === 'related_to' ? '#c08a3e' : '#9C978C'}
                        strokeWidth={Math.min(2.2, 0.7 + (edge.weight || 1) * 0.25) / Math.max(1, transform.k * 0.7)}
                        markerEnd="url(#graph-arrow)"
                      />
                      <title>{edge.type === 'contains' ? '包含' : edge.type === 'mentions' ? '提及' : '共同主题'} · 权重 {edge.weight}</title>
                    </g>
                  );
                })}
                {focusNodes.map((node: any) => {
                  const p = positions.get(node.id); if (!p) return null;
                  const dimmed = hoverId && neighborIds && !(neighborIds.has(node.id));
                  const isMatch = matchIds && matchIds.has(node.id);
                  const isSelected = selected === node.id;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${p.x},${p.y})`}
                      opacity={dimmed ? 0.18 : 1}
                      className={`graph-node ${isSelected ? 'selected' : ''}`}
                      onMouseEnter={() => setHovered(node.id)}
                      onMouseLeave={() => setHovered(null)}
                      onMouseDown={(e) => startNodeDrag(e, node)}
                      onClick={(e) => onNodeClick(e, node)}
                      onDoubleClick={(e) => onNodeDouble(e, node)}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle
                        r={nodeRadius(node)}
                        fill={nodeColor[node.type]}
                        stroke={isSelected ? '#111827' : isMatch ? '#B7791F' : 'white'}
                        strokeWidth={isSelected ? 2.5 : isMatch ? 2 : 1.5}
                      />
                      {(isMatch || (showLabel(node))) && (
                        <text x={nodeRadius(node) + 5} y={4} className="graph-node-label" style={{ fontSize: 11 / transform.k }}>
                          {labelText(node)}
                        </text>
                      )}
                      <title>{node.label} · {node.type === 'knowledge_base' ? '知识库' : node.type === 'document' ? '文档' : '主题'}</title>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          <div className="graph-zoom-ctl">
            <button type="button" onClick={() => setTransform({ ...transform, k: Math.min(3.5, transform.k * 1.2) })} aria-label="放大">＋</button>
            <span className="graph-zoom-pct">{Math.round(transform.k * 100)}%</span>
            <button type="button" onClick={() => setTransform({ ...transform, k: Math.max(0.3, transform.k / 1.2) })} aria-label="缩小">−</button>
            <button type="button" onClick={resetView} title="重置视图">⤾</button>
            {selected && <button type="button" onClick={centerOnSelected} title="居中到选中节点">⊙</button>}
          </div>
        </div>

        <aside className="graph-detail">
          {selectedNode ? (
            <>
              <div className="graph-detail-type" style={{ color: nodeColor[selectedNode.type] }}>
                {selectedNode.type === 'knowledge_base' ? '知识库' : selectedNode.type === 'document' ? '文档' : '主题'}
              </div>
              <h3>{selectedNode.label}</h3>
              <div className="graph-detail-actions">
                {selectedNode.type === 'document' && selectedNode.documentId && selectedNode.kbId && (
                  <button type="button" className="btn primary" onClick={() => onOpenDocument?.(selectedNode.kbId, selectedNode.documentId, selectedNode.label)}>
                    打开文档
                  </button>
                )}
                {selectedNode.type === 'knowledge_base' && selectedNode.kbId && (
                  <button type="button" className="btn primary" onClick={() => onOpenKb?.(selectedNode.kbId)}>
                    进入知识库
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setLocalRoot(selectedNode.id)}>
                  展开局部图谱
                </button>
              </div>
              <p>
                {selectedNode.type === 'document' && '该节点来自可见知识库中的已发布文档。'}
                {selectedNode.type === 'concept' && '该主题由章节、标题、显式引用和文档内容共同提取。'}
                {selectedNode.type === 'knowledge_base' && '该节点表示一个可见知识库。'}
              </p>
              {(['contains', 'mentions', 'related_to'] as const).map((type) => {
                const list = relatedByType[type] || [];
                if (list.length === 0) return null;
                const label = type === 'contains' ? '包含的文档' : type === 'mentions' ? '提及该主题的文档' : '相关文档';
                return (
                  <div className="graph-related" key={type}>
                    <b>{label} <em>· {list.length}</em></b>
                    {list.slice(0, 8).map((edge: any) => {
                      const otherId = edge.source === selected ? edge.target : edge.source;
                      const other = allNodes.find((n: any) => n.id === otherId);
                      return (
                        <div key={edge.id} className="graph-related-row" onClick={() => setSelected(otherId)}>
                          <span style={{ color: nodeColor[type === 'contains' ? 'document' : 'concept'] }}>·</span>
                          {other?.label || '—'}
                        </div>
                      );
                    })}
                    {list.length > 8 && <div className="graph-related-more">还有 {list.length - 8} 条…</div>}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <h3>点击节点查看详情</h3>
              <p>图谱不会显示无权限知识。点击文档或主题节点，可查看它与其他知识的关联；双击可直达原始文档或知识库。</p>
              <div className="graph-detail-hints">
                <div><kbd>滚轮</kbd> 缩放 · <kbd>拖拽空白</kbd> 平移 · <kbd>拖拽节点</kbd> 布局</div>
                <div><kbd>悬停</kbd> 高亮邻居 · <kbd>点击</kbd> 查看 · <kbd>双击</kbd> 打开</div>
                <div><kbd>⌘F</kbd> 聚焦搜索 · <kbd>Esc</kbd> 取消选择</div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
