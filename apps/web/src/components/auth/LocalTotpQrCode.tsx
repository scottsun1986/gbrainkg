"use client";

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/** The provisioning secret stays in the browser; rendering never calls a QR service. */
export function LocalTotpQrCode({ otpauthUri }: { otpauthUri: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (canvas.current) {
      void QRCode.toCanvas(canvas.current, otpauthUri, { width: 168, margin: 4, errorCorrectionLevel: 'M' })
        .catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; };
  }, [otpauthUri]);
  return failed
    ? <div role="status">二维码生成失败，请使用下方密钥手动绑定。</div>
    : <canvas ref={canvas} role="img" aria-label="身份验证器绑定二维码" style={{ borderRadius: 8, background: '#fff' }} />;
}
