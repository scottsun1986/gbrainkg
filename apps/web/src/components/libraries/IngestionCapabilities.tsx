'use client';
import React, { useEffect, useState } from 'react';
import { ingestionRequest } from '../../lib/ingestion-ui';
export interface IngestionCapabilitiesData { extensions: string[]; qaExtensions: string[]; limits: { uploadBytes: number; archiveFiles: number; archiveTotalBytes: number; archiveFileBytes: number; ocrBytes: number; qaRows: number; qaBytes: number }; notes: string[] }
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
export function IngestionCapabilities({ onLoaded }: { onLoaded?: (data: IngestionCapabilitiesData) => void }) {
  const [data, setData] = useState<IngestionCapabilitiesData | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void ingestionRequest<IngestionCapabilitiesData>('/kbs/ingestion-capabilities', { signal: controller.signal }).then(value => { setData(value); onLoaded?.(value); }).catch(() => {});
    return () => controller.abort();
  }, [onLoaded]);
  return <details style={{ margin: '10px 0 16px', fontSize: 12, color: 'var(--ink-3)' }}><summary>支持格式、解析范围与资源限制</summary>
    {data ? <><p>文档：{data.extensions.join('、')}。标准问答：{data.qaExtensions.join('、')}（请使用标准问答页的字段映射与审核）。</p><p>单文件 {mb(data.limits.uploadBytes)}；OCR 输入 {mb(data.limits.ocrBytes)}；压缩包最多 {data.limits.archiveFiles} 个文档，解压合计 {mb(data.limits.archiveTotalBytes)}、单项 {mb(data.limits.archiveFileBytes)}；问答文件 {mb(data.limits.qaBytes)}、最多 {data.limits.qaRows} 条。</p>{data.notes?.map((note, index) => <p key={index}>{note}</p>)}</> : <p>当前未取得服务器格式与预算配置，请稍后重试。</p>}
    <p>MD 与相对图片请放在同一 ZIP / TAR 资源包并保留目录。外部图片不自动下载。接收成功仅表示文件进入处理队列，内容覆盖、失败区域和派生说明可在文档详情中查看。</p>
  </details>;
}
