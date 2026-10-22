import type { Asset } from '@/core/types';
import type { Rasterizer } from './executor';

/** Browser rasteriser: any image the browser can decode (incl. SVG mock concepts) → JPEG for the PDF. */
export const browserRasterizer: Rasterizer = async (asset: Asset, bytes: Uint8Array) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: asset.mimeType }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const maxEdge = 1400;
    const w0 = img.naturalWidth || asset.width || 800;
    const h0 = img.naturalHeight || asset.height || 800;
    const s = Math.min(1, maxEdge / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * s);
    canvas.height = Math.round(h0 * s);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.86), width: canvas.width, height: canvas.height, format: 'JPEG' };
  } finally {
    URL.revokeObjectURL(url);
  }
};
