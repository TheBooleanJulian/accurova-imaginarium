import { GState, jsPDF } from 'jspdf';
import type { Approval, Asset, Project } from '@/core/types';
import type { Brief, ShotPlan } from '@/core/schemas';
import { approvalStateOf, type ApprovedBundle, type DirectionValue } from '@/core/graph';
import { AI_DISCLAIMER } from '@/core/executors';

export interface RasterImage {
  dataUrl: string;
  width: number;
  height: number;
  format: 'JPEG' | 'PNG';
}

export interface PackInput {
  project: Project;
  title: string;
  mode: 'draft' | 'final';
  brief: Brief | null;
  approved: ApprovedBundle | null;
  /** Extra images wired straight into the export node (draft packs). */
  draftImageIds: string[];
  shotplan: ShotPlan | null;
  includeReferences: boolean;
  assets: Asset[];
  approvals: Approval[];
  generatedBy: string;
  rasterize: (asset: Asset) => Promise<RasterImage | null>;
  now?: Date;
}

export interface PackResult {
  bytes: Uint8Array;
  pageCount: number;
  filename: string;
  imageCount: number;
}

const W = 297;
const H = 210;
const M = 14;
const TEAL: [number, number, number] = [0, 212, 200];
const GOLD: [number, number, number] = [245, 200, 66];
const VOID: [number, number, number] = [5, 5, 8];
const INK: [number, number, number] = [24, 28, 36];
const MUTE: [number, number, number] = [110, 118, 130];
const PAPER: [number, number, number] = [248, 247, 243];

/** Helvetica in jsPDF is WinAnsi-only: map the few typographic glyphs we use, drop the rest. */
export function safe(s: unknown): string {
  return String(s ?? '')
    .replace(/[→⟶]/g, '->')
    .replace(/[≈]/g, '~')
    .replace(/[•]/g, '·')
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”…€]/g, '');
}

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function packFilename(project: Project, mode: 'draft' | 'final', now = new Date()): string {
  const slug = `${project.client}-${project.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const d = now.toISOString().slice(0, 10);
  return `accurova-${slug || 'project'}-${mode === 'final' ? 'approved-pack' : 'draft'}-${d}.pdf`;
}

export async function buildPreshootPack(input: PackInput): Promise<PackResult> {
  const now = input.now ?? new Date();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const isFinal = input.mode === 'final';
  const byId = (id: string) => input.assets.find((a) => a.id === id);
  const direction: DirectionValue | null = input.approved?.direction ?? null;
  const plan = input.approved?.shotplan ?? input.shotplan;

  // Which images go in. Final: client-approved only. Draft: everything under review + extras.
  const reviewIds = input.approved
    ? isFinal
      ? input.approved.assetIds
      : [...input.approved.assetIds, ...input.approved.pendingAssetIds, ...input.approved.changesRequestedAssetIds]
    : [];
  const boardIds = isFinal ? reviewIds : [...new Set([...reviewIds, ...input.draftImageIds])];
  const board = boardIds.map(byId).filter((a): a is Asset => !!a && a.sourceType !== 'export');
  const concepts = board.filter((a) => a.role === 'concept' || a.role === 'edit');
  const poses = board.filter((a) => a.role === 'pose');
  const uploads = input.includeReferences ? input.assets.filter((a) => a.sourceType === 'upload') : [];
  const products = uploads.filter((a) => a.role === 'product' || a.role === 'brand');
  const refs = uploads.filter((a) => a.role === 'reference');

  const raster = new Map<string, RasterImage | null>();
  for (const a of [...products, ...refs, ...concepts, ...poses]) if (!raster.has(a.id)) raster.set(a.id, await input.rasterize(a).catch(() => null));

  let first = true;
  const newPage = (dark = false) => {
    if (!first) doc.addPage();
    first = false;
    doc.setFillColor(...(dark ? VOID : PAPER));
    doc.rect(0, 0, W, H, 'F');
  };
  const header = (title: string, kicker: string) => {
    doc.setFillColor(...VOID);
    doc.rect(0, 0, W, 18, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(255, 255, 255);
    doc.text('ACCUROVA', M, 11.5);
    doc.setFont('helvetica', 'normal').setTextColor(...TEAL);
    doc.text('IMAGINARIUM', M + 21, 11.5);
    doc.setTextColor(180, 186, 196).text(safe(`${input.project.client} · ${input.project.name}`), W - M, 11.5, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTE).text(safe(kicker.toUpperCase()), M, 28);
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...INK).text(safe(title), M, 36);
  };
  const para = (text: string, x: number, y: number, w: number, size = 9.5, color: [number, number, number] = INK, lh = 1.35): number => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(...color);
    const lines = doc.splitTextToSize(safe(text), w) as string[];
    doc.text(lines, x, y, { lineHeightFactor: lh });
    return y + lines.length * size * 0.3528 * lh;
  };
  const label = (text: string, x: number, y: number, color: [number, number, number] = MUTE) => {
    doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(...color).text(safe(text.toUpperCase()), x, y);
  };

  // ---- 1. Cover
  newPage(true);
  doc.setDrawColor(...TEAL).setLineWidth(1.2).circle(M + 8, 30, 7, 'S');
  doc.setFillColor(...GOLD).circle(M + 8, 30, 2.6, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(255, 255, 255).text('ACCUROVA', M + 20, 29);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...TEAL).text('IMAGINARIUM  ·  PRESHOOT PACK', M + 20, 34);
  doc.setFont('helvetica', 'bold').setFontSize(34).setTextColor(255, 255, 255);
  doc.text(doc.splitTextToSize(safe(input.title), W - 2 * M - 60) as string[], M, 92, { lineHeightFactor: 1.1 });
  doc.setFont('helvetica', 'normal').setFontSize(13).setTextColor(200, 205, 212).text(safe(`${input.project.client} — ${input.project.name}`), M, 122);
  const stamp = isFinal ? 'CLIENT-APPROVED' : 'DRAFT · WORK IN PROGRESS';
  doc.setFillColor(...(isFinal ? TEAL : GOLD));
  doc.roundedRect(M, 132, doc.getTextWidth(stamp) * 0.75 + 12, 9, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...VOID).text(stamp, M + 6, 138);
  const meta = [
    ['Prepared', now.toLocaleDateString('en-SG', { day: 'numeric', month: 'long', year: 'numeric' })],
    ['Prepared by', input.generatedBy],
    ['Direction', direction?.title ?? '—'],
    ['Approved images', String(input.approved?.assetIds.length ?? 0)],
    ['Shots planned', String(plan?.shots.length ?? 0)],
  ];
  meta.forEach(([k, v], i) => {
    label(k!, M + i * 54, 172, [120, 128, 140]);
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(235, 238, 242).text(safe(v), M + i * 54, 179);
  });
  doc.setFontSize(7.5).setTextColor(120, 128, 140).text(safe(`AI imagery in this pack is conceptual. ${isFinal ? '' : 'Unapproved items are marked.'}`), M, H - 10);

  // ---- 2. Brief + direction
  newPage();
  header(direction ? `Creative direction: ${direction.title}` : 'Campaign brief', 'Brief & direction');
  let yL = 48;
  const colW = (W - 3 * M) / 2;
  if (input.brief) {
    const rows: [string, string][] = [
      ['Client', input.brief.client], ['Product', input.brief.product], ['Audience', input.brief.audience],
      ['Objective', input.brief.objective], ['Visual style', input.brief.visualStyle], ['Deliverables', input.brief.deliverables], ['Constraints', input.brief.constraints],
    ];
    for (const [k, v] of rows) {
      if (!v?.trim()) continue;
      label(k, M, yL);
      yL = para(v, M, yL + 4.5, colW, 9.5) + 3;
    }
  } else {
    para('No brief connected to the export node.', M, yL, colW, 9.5, MUTE);
  }
  let yR = 48;
  const xR = M * 2 + colW;
  if (direction) {
    yR = para(direction.creativeDirection, xR, yR, colW, 10.5) + 3;
    direction.palette.forEach((c, i) => {
      const rgb = hexRgb(c);
      if (rgb) doc.setFillColor(...rgb).rect(xR + i * 18, yR, 16, 9, 'F');
      doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(...MUTE).text(safe(c), xR + i * 18, yR + 13);
    });
    yR += 19;
    for (const [k, v] of [
      ['Rationale', direction.rationale],
      ['Lighting', direction.lighting],
      ['Poses', direction.poseSuggestions.join(' · ')],
      ['Set & props', direction.backgroundAndProps.join(' · ')],
      ['Avoid', direction.negativeInstructions.join(' · ')],
    ] as const) {
      if (!v) continue;
      label(k, xR, yR);
      yR = para(v, xR, yR + 4.5, colW, 9) + 2.5;
      if (yR > H - 20) break;
    }
  } else {
    para(isFinal ? 'No approved creative direction was connected.' : 'Select a creative direction in the concept generator to include it here.', xR, yR, colW, 9.5, MUTE);
  }

  // ---- 3. Image grids
  const grid = (title: string, kicker: string, list: Asset[], caption: (a: Asset) => [string, string, [number, number, number]]) => {
    const cols = 3;
    const rows = 2;
    const gw = (W - 2 * M - (cols - 1) * 6) / cols;
    const gh = 62;
    for (let start = 0; start < list.length; start += cols * rows) {
      newPage();
      header(title, start ? `${kicker} (cont.)` : kicker);
      list.slice(start, start + cols * rows).forEach((a, i) => {
        const cx = M + (i % cols) * (gw + 6);
        const cy = 44 + Math.floor(i / cols) * (gh + 17);
        doc.setFillColor(232, 230, 224).rect(cx, cy, gw, gh, 'F');
        const r = raster.get(a.id);
        if (r) {
          const s = Math.min(gw / r.width, gh / r.height);
          const iw = r.width * s;
          const ih = r.height * s;
          try {
            doc.addImage(r.dataUrl, r.format, cx + (gw - iw) / 2, cy + (gh - ih) / 2, iw, ih, undefined, 'FAST');
          } catch {
            para('Image unavailable', cx + 3, cy + gh / 2, gw - 6, 8, MUTE);
          }
        } else {
          para('Image unavailable', cx + 3, cy + gh / 2, gw - 6, 8, MUTE);
        }
        const [tag, line2, color] = caption(a);
        doc.setFillColor(...color).rect(cx, cy + gh + 2, 2, 9, 'F');
        doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(...color).text(safe(tag), cx + 4, cy + gh + 5.5);
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...INK);
        doc.text((doc.splitTextToSize(safe(line2), gw - 5) as string[]).slice(0, 2), cx + 4, cy + gh + 9.5);
      });
      doc.setFont('helvetica', 'italic').setFontSize(7).setTextColor(...MUTE).text(safe(title.includes('Real') ? 'Original files, unmodified.' : AI_DISCLAIMER), M, H - 14);
    }
  };
  const statusCaption = (a: Asset): [string, string, [number, number, number]] => {
    const s = approvalStateOf(input.approvals, a.id);
    const kind = a.role === 'pose' ? 'AI POSE REFERENCE' : a.role === 'edit' ? `AI CONCEPT v${a.version}` : 'AI CONCEPT';
    const st = s === 'approved' ? 'APPROVED' : s === 'changes_requested' ? 'CHANGES REQUESTED' : 'PENDING REVIEW';
    const color: [number, number, number] = s === 'approved' ? [0, 150, 140] : s === 'changes_requested' ? [200, 60, 60] : [190, 140, 20];
    return [`${kind} · ${st}`, a.label ?? '', color];
  };
  if (products.length) grid('Real product & brand assets', 'Moodboard', products, (a) => ['REAL PRODUCT PHOTO', a.originalFilename ?? a.label ?? '', [190, 140, 20]]);
  if (refs.length) grid('Visual references', 'Moodboard', refs, (a) => ['INSPIRATION REFERENCE', a.originalFilename ?? a.label ?? '', MUTE]);
  if (concepts.length) grid(isFinal ? 'Approved concepts' : 'Concepts', 'Moodboard', concepts, statusCaption);
  if (poses.length) grid(isFinal ? 'Approved pose references' : 'Pose references', 'Direction on set', poses, statusCaption);
  if (!concepts.length && !poses.length) {
    newPage();
    header(isFinal ? 'Approved concepts' : 'Concepts', 'Moodboard');
    para(isFinal ? 'No images have been approved yet.' : 'No concept images connected to the export node yet.', M, 50, 200, 11, MUTE);
  }

  // ---- 4. Shot list
  if (plan) {
    const cols: [string, number, (s: ShotPlan['shots'][number]) => string][] = [
      ['ID', 12, (s) => s.id],
      ['Pri.', 13, (s) => s.priority],
      ['Shot & pose direction', 62, (s) => `${s.title}\n${s.poseDirection}`],
      ['Angle / framing', 36, (s) => `${s.cameraAngle}\n${s.framing}`],
      ['Lens & position', 40, (s) => `${s.lens}\n${s.cameraPosition}`],
      ['Lighting & modifiers', 58, (s) => `${s.lighting}${s.modifiers.length ? `\n${s.modifiers.join(', ')}` : ''}`],
      ['Product / set', 34, (s) => `${s.productPlacement}\n${s.background}`],
      ['Min', 14, (s) => String(s.setupMinutes)],
    ];
    let y = 0;
    const startTable = (cont: boolean) => {
      newPage();
      header('Shot list', cont ? 'Production plan (cont.)' : 'Production plan');
      y = 44;
      doc.setFillColor(...VOID).rect(M, y, W - 2 * M, 7, 'F');
      let x = M + 2;
      for (const [h, w] of cols) {
        doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(255, 255, 255).text(h, x, y + 4.8);
        x += w;
      }
      y += 9;
    };
    startTable(false);
    plan.shots.forEach((s, idx) => {
      doc.setFont('helvetica', 'normal').setFontSize(7.5);
      const cells = cols.map(([, w, f]) => doc.splitTextToSize(safe(f(s)), w - 3) as string[]);
      const lines = Math.min(7, Math.max(...cells.map((c) => c.length)));
      const rowH = lines * 3.4 + 3;
      if (y + rowH > H - 16) startTable(true);
      if (idx % 2 === 0) doc.setFillColor(238, 236, 230).rect(M, y - 1, W - 2 * M, rowH, 'F');
      let x = M + 2;
      cells.forEach((c, i) => {
        doc.setTextColor(...(i === 0 ? TEAL : INK)).setFont('helvetica', i === 0 || i === 1 ? 'bold' : 'normal');
        doc.text(c.slice(0, 7), x, y + 2.6, { lineHeightFactor: 1.15 });
        x += cols[i]![1];
      });
      y += rowH;
    });

    newPage();
    header('Lighting & equipment', 'Production plan');
    label('Lighting plan', M, 48);
    let ly = para(plan.lightingPlan, M, 53, colW, 10) + 6;
    label('Summary', M, ly);
    ly = para(`${plan.summary} Estimated total setup: ${Math.round(plan.totalSetupMinutes / 6) / 10} h across ${plan.shots.length} shots.`, M, ly + 5, colW, 9.5) + 6;
    para(plan.disclaimer, M, ly, colW, 8.5, MUTE);
    label('Equipment checklist', xR, 48);
    plan.equipmentChecklist.forEach((item, i) => {
      const yy = 55 + i * 6.2;
      if (yy > H - 16) return;
      doc.setDrawColor(...MUTE).setLineWidth(0.3).rect(xR, yy - 3, 3.2, 3.2, 'S');
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...INK).text(safe(item), xR + 6, yy);
    });
  }

  // ---- 5. Approval record
  newPage();
  header('Approval record', 'Client sign-off');
  const reviewed = [...new Set([...reviewIds, ...input.approvals.map((a) => a.assetId)])].map(byId).filter((a): a is Asset => !!a && a.sourceType === 'ai_generated');
  let ay = 48;
  if (!reviewed.length) para('No review decisions recorded yet.', M, ay, 200, 10, MUTE);
  for (const a of reviewed) {
    if (ay > H - 20) break;
    const hist = input.approvals.filter((x) => x.assetId === a.id).sort((p, q) => (p.createdAt < q.createdAt ? 1 : -1));
    const s = approvalStateOf(input.approvals, a.id);
    const tone: [number, number, number] = s === 'approved' ? [0, 150, 140] : s === 'changes_requested' ? [200, 60, 60] : [190, 140, 20];
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...tone);
    doc.text(s === 'approved' ? 'APPROVED' : s === 'changes_requested' ? 'CHANGES' : 'PENDING', M, ay);
    doc.setFont('helvetica', 'normal').setTextColor(...INK).text(safe(`${a.label ?? a.id} (v${a.version})`), M + 26, ay);
    const latest = hist[0];
    if (latest) {
      doc.setTextColor(...MUTE).text(safe(`${latest.reviewerName ?? 'Reviewer'} · ${new Date(latest.createdAt).toLocaleString('en-SG')}${latest.comment ? ` — “${latest.comment}”` : ''}`).slice(0, 140), M + 120, ay);
    }
    ay += 7;
  }

  // ---- footers + draft watermark
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    if (!isFinal && i > 1) {
      // Translucent so the watermark never hides the imagery underneath.
      doc.saveGraphicsState();
      doc.setGState(new GState({ opacity: 0.1 }));
      doc.setFont('helvetica', 'bold').setFontSize(80).setTextColor(190, 140, 20);
      doc.text('DRAFT', W / 2, H / 2 + 20, { align: 'center', angle: 25 });
      doc.restoreGraphicsState();
    }
    const footTone: [number, number, number] = i === 1 ? [120, 128, 140] : MUTE;
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...footTone);
    doc.text(safe(`Accurova · Confidential · ${isFinal ? 'Approved pack' : 'Draft'} · ${now.toISOString().slice(0, 10)}`), W - M, H - 6, { align: 'right' });
    doc.text(`${i} / ${pages}`, M, H - 6);
  }

  return {
    bytes: new Uint8Array(doc.output('arraybuffer')),
    pageCount: pages,
    filename: packFilename(input.project, input.mode, now),
    imageCount: raster.size,
  };
}
