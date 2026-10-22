import sharp, { type Metadata } from 'sharp';
import type { Asset } from '../src/core/types';
import type { RasterImage } from '../src/features/export/pdf';

/** Formats we accept from users, identified by decoding the file, never by its name or declared type. */
const ACCEPTED: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export interface ProbedImage {
  mimeType: string;
  width: number;
  height: number;
}

/** Decode the header and confirm it is a real JPEG/PNG/WebP of sane dimensions. */
export async function probeImage(bytes: Uint8Array): Promise<ProbedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: 'error', limitInputPixels: 120_000_000 }).metadata();
  } catch {
    throw new ImageValidationError('That file is not a readable image. Use JPEG, PNG or WebP.');
  }
  const mimeType = meta.format ? ACCEPTED[meta.format] : undefined;
  if (!mimeType) throw new ImageValidationError(`Unsupported image format (${meta.format ?? 'unknown'}). Use JPEG, PNG or WebP.`);
  if (!meta.width || !meta.height) throw new ImageValidationError('Could not read the image dimensions.');
  if (meta.width < 16 || meta.height < 16) throw new ImageValidationError('Image is too small (minimum 16×16).');
  // EXIF orientation 5–8 swaps width and height when displayed.
  const swap = (meta.orientation ?? 1) >= 5;
  return { mimeType, width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

/** Small WebP preview for canvases and grids. Originals are never modified. */
export async function makeThumbnail(bytes: Uint8Array, edge = 512): Promise<Uint8Array> {
  return new Uint8Array(await sharp(bytes).rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer());
}

/** Rasterise SVG (mock provider output) to PNG so everything stored and served is a bitmap. */
export async function svgToPng(svg: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(svg, { density: 96 }).resize(width, height, { fit: 'fill' }).png({ compressionLevel: 8 }).toBuffer());
}

/** Downscale for vision prompts: keeps token usage bounded. */
export async function forVision(bytes: Uint8Array, maxEdge = 1536): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const out = await sharp(bytes).rotate().resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { bytes: new Uint8Array(out), mimeType: 'image/jpeg' };
}

/** PNG at an exact size (image-edit APIs want PNG). */
export async function toPng(bytes: Uint8Array, maxEdge = 1536): Promise<Uint8Array> {
  return new Uint8Array(await sharp(bytes).rotate().resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());
}

/** Server-side rasteriser for the PDF export: any stored image → JPEG data URL. */
export async function rasterizeForPdf(_asset: Asset, bytes: Uint8Array): Promise<RasterImage | null> {
  const img = sharp(bytes).rotate().flatten({ background: '#ffffff' }).resize(1400, 1400, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.jpeg({ quality: 84 }).toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height, format: 'JPEG' };
}
