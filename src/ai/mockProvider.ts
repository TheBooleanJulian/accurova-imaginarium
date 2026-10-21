import type { AIProvider, AnalyzeRequest, DirectionsRequest, GeneratedImage, ImageRequest, ProviderResult, ShotPlanRequest } from '@/core/ai';
import { ProviderError, throwIfAborted } from '@/core/ai';
import { aspectToSize, type Direction, type ReferenceAnalysis, type ShotPlan } from '@/core/schemas';
import { hashString } from '@/core/hash';

/**
 * Deterministic offline provider for development, demos and tests.
 * Produces schema-valid JSON and clearly-labelled SVG placeholder images.
 * It never pretends to be a real model: every image says "MOCK AI CONCEPT".
 */
export interface MockOptions {
  latencyMs?: number;
  /** Fail the first N calls (tests for retry behaviour). */
  failTimes?: number;
  failRetryable?: boolean;
}

const DIRECTION_BANK: Omit<Direction, 'rationale' | 'proposedShots'>[] = [
  {
    title: 'Quiet Authority',
    creativeDirection: 'Restrained, editorial corporate portraiture. Deep charcoal set, sculpted single-source light, generous negative space for copy.',
    palette: ['#0A0E14', '#1F2A36', '#C9B79C', '#F2EFE9'],
    lighting: 'Large octabox key 45° camera-left, slightly above eye line; black V-flat for negative fill camera-right; strip-box rim from behind right.',
    poseSuggestions: ['Weight on back foot, shoulders angled 30° from camera', 'Hands lightly clasped at waist', 'Chin slightly down, eyes to lens'],
    backgroundAndProps: ['Charcoal seamless paper', 'Low walnut plinth for product', 'Single architectural chair'],
    constraints: ['Keep product logo legible', 'Leave top third clear for headline'],
    negativeInstructions: ['No lens flare', 'No busy patterns', 'No over-smoothed skin'],
  },
  {
    title: 'Golden Hour Ritual',
    creativeDirection: 'Warm, human, late-afternoon light through tall windows. Feels lived-in and aspirational without losing polish.',
    palette: ['#2B1B12', '#B8743A', '#F3C98B', '#FFF4E2'],
    lighting: 'Hard sun simulation: bare head through diffusion scrim from high camera-right; warm bounce card low left; gentle haze.',
    poseSuggestions: ['Mid-movement, turning toward the light', 'Product held at chest height, relaxed grip', 'Candid half-smile, gaze off-frame'],
    backgroundAndProps: ['Linen curtains', 'Terracotta and wood textures', 'Ceramic cup / notebook as lifestyle cues'],
    constraints: ['Shoot between 4–6 pm or simulate', 'Keep skin tones natural'],
    negativeInstructions: ['No orange over-grading', 'No clutter in frame edges'],
  },
  {
    title: 'Monochrome Precision',
    creativeDirection: 'Graphic, high-contrast and minimal. Hard shadows and clean geometry make the product the hero.',
    palette: ['#050508', '#3A3F47', '#D9DDE2', '#00D4C8'],
    lighting: 'Hard zoom reflector key from top-left at 60° creating crisp cast shadows; small accent gel light (teal) on background.',
    poseSuggestions: ['Strong vertical posture, square to camera', 'Product presented in one hand at shoulder height', 'Profile silhouette against the accent'],
    backgroundAndProps: ['Light-grey cyclorama', 'Geometric acrylic blocks', 'Matte black riser'],
    constraints: ['Accent colour max 10% of frame'],
    negativeInstructions: ['No soft, flat lighting', 'No warm colour casts'],
  },
  {
    title: 'Tropical Modernism',
    creativeDirection: 'Singapore-rooted: lush greenery meets clean modern architecture. Fresh, optimistic, place-specific.',
    palette: ['#0F2A1D', '#2F6B4F', '#E7E2D3', '#F5C842'],
    lighting: 'Open shade key with a large silver reflector camera-left; dappled leaf-break gobo on background; fast shutter for daylight balance.',
    poseSuggestions: ['Walking toward camera along a corridor', 'Leaning on a concrete column, relaxed', 'Looking up into the canopy'],
    backgroundAndProps: ['Tropical plants, monstera leaves', 'Breeze-block or fair-faced concrete wall', 'Rattan accents'],
    constraints: ['Location permits for public spaces', 'Plan around afternoon rain'],
    negativeInstructions: ['No touristy landmarks unless briefed', 'No oversaturated greens'],
  },
  {
    title: 'Kinetic Studio',
    creativeDirection: 'Energetic and modern. Motion, bold colour blocking and dynamic angles for social-first deliverables.',
    palette: ['#14121F', '#5B2EFF', '#FF5C8A', '#F7F7F2'],
    lighting: 'Two-light cross: gridded strip boxes left and right with coloured gels; front fill at -2 stops; flash freeze for motion.',
    poseSuggestions: ['Jump or stride captured at peak', 'Product tossed and caught', 'Low hero angle, arms open'],
    backgroundAndProps: ['Colour-blocked paper panels', 'Floating product on clear rod', 'Confetti or fabric motion'],
    constraints: ['Vertical 9:16 safe area for social'],
    negativeInstructions: ['No motion blur on the product', 'No clashing logos'],
  },
];

const LENSES = ['35mm f/2.8', '50mm f/2.8', '85mm f/4', '100mm macro f/8', '24-70mm @ 50mm f/5.6', '70-200mm @ 135mm f/4'];

function pickN<T>(arr: T[], n: number, seed: string): T[] {
  const start = parseInt(hashString(seed).slice(0, 6), 16) % arr.length;
  return Array.from({ length: n }, (_, i) => arr[(start + i * 2) % arr.length]!);
}

function num(seed: string, mod: number): number {
  return parseInt(hashString(seed).slice(2, 10), 16) % mod;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Draws a stylised studio scene: backdrop, key light, figure and product. */
export function drawScene(opts: {
  width: number;
  height: number;
  palette: string[];
  title: string;
  subtitle: string;
  seed: string;
  kind: 'concept' | 'pose' | 'edit';
  lightFromRight: boolean;
  sourceDataUri?: string;
}): string {
  const { width: w, height: h, palette, seed } = opts;
  const [c0 = '#0A0E14', c1 = '#1F2A36', c2 = '#C9B79C', c3 = '#F2EFE9'] = palette;
  const lx = opts.lightFromRight ? w * 0.8 : w * 0.2;
  const armL = -60 + num(seed + 'l', 120);
  const armR = -60 + num(seed + 'r', 120);
  const tilt = -14 + num(seed + 't', 28);
  const cx = w * (0.42 + num(seed + 'x', 16) / 100);
  const s = Math.min(w, h) / 800;
  const figure = `
    <g transform="translate(${cx} ${h * 0.34}) scale(${s})" fill="${c0}" opacity="0.92">
      <g transform="rotate(${tilt})"><circle cx="0" cy="0" r="46"/></g>
      <path d="M-70 70 Q0 40 70 70 L95 380 L-95 380 Z"/>
      <g transform="translate(-72 92) rotate(${armL})"><rect x="-16" y="0" width="32" height="190" rx="16"/></g>
      <g transform="translate(72 92) rotate(${-armR})"><rect x="-16" y="0" width="32" height="190" rx="16"/></g>
      <rect x="-80" y="380" width="62" height="250" rx="22"/><rect x="18" y="380" width="62" height="250" rx="22"/>
    </g>
    <g transform="translate(${cx + 110 * s} ${h * 0.34 + 250 * s}) rotate(${-8 + num(seed + 'p', 16)})">
      <rect x="${-38 * s}" y="${-60 * s}" width="${76 * s}" height="${120 * s}" rx="${10 * s}" fill="${c2}" stroke="${c3}" stroke-width="${3 * s}"/>
      <rect x="${-22 * s}" y="${-20 * s}" width="${44 * s}" height="${8 * s}" rx="${4 * s}" fill="${c3}" opacity="0.8"/>
    </g>`;
  const base = opts.sourceDataUri
    ? `<image href="${opts.sourceDataUri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
       <rect width="${w}" height="${h}" fill="${c1}" opacity="0.28" style="mix-blend-mode:color"/>`
    : `<rect width="${w}" height="${h}" fill="url(#bg)"/>
       <ellipse cx="${w / 2}" cy="${h * 0.93}" rx="${w * 0.62}" ry="${h * 0.12}" fill="${c0}" opacity="0.45"/>
       <circle cx="${lx}" cy="${h * 0.22}" r="${Math.max(w, h) * 0.55}" fill="url(#key)"/>
       ${figure}`;
  const tag = opts.kind === 'pose' ? 'MOCK AI · POSE REFERENCE' : opts.kind === 'edit' ? 'MOCK AI · EDITED CONCEPT' : 'MOCK AI CONCEPT';
  const fs = Math.max(14, Math.round(Math.min(w, h) / 34));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></linearGradient>
    <radialGradient id="key"><stop offset="0" stop-color="${c3}" stop-opacity="0.55"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/></radialGradient>
  </defs>
  ${base}
  <rect x="0" y="${h - fs * 4.2}" width="${w}" height="${fs * 4.2}" fill="#050508" opacity="0.72"/>
  <text x="${fs}" y="${h - fs * 2.5}" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#F2EFE9">${esc(opts.title).slice(0, 60)}</text>
  <text x="${fs}" y="${h - fs * 1.1}" font-family="Courier New, monospace" font-size="${Math.round(fs * 0.72)}" fill="#00D4C8">${esc(tag)} · ${esc(opts.subtitle).slice(0, 70)}</text>
</svg>`;
}

export class MockProvider implements AIProvider {
  readonly id = 'mock';
  private calls = 0;
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  modelFor(kind: 'text' | 'image'): string {
    return kind === 'image' ? 'mock-image-1' : 'mock-vision-1';
  }

  private async gate(signal: AbortSignal) {
    this.calls++;
    const ms = this.opts.latencyMs ?? 0;
    if (ms) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }).catch(() => undefined);
    }
    throwIfAborted(signal);
    if (this.opts.failTimes && this.calls <= this.opts.failTimes) {
      throw new ProviderError(`Mock provider failure #${this.calls}`, { retryable: this.opts.failRetryable ?? true, code: 'mock_failure' });
    }
  }

  async analyzeReferences(req: AnalyzeRequest, signal: AbortSignal): Promise<ProviderResult<unknown>> {
    await this.gate(signal);
    const d = pickN(DIRECTION_BANK, 1, req.images.map((i) => i.assetId).join())[0]!;
    const value: ReferenceAnalysis = {
      summary: `${req.images.length} reference${req.images.length === 1 ? '' : 's'} analysed. The set leans toward ${d.title.toLowerCase()}: ${d.creativeDirection.split('.')[0]!.toLowerCase()}.`,
      composition: 'Subject placed on the left third with clear negative space right; mostly eye-level framing with a moderate telephoto compression.',
      lighting: d.lighting,
      colour: { palette: d.palette, contrast: 'Medium-high, controlled highlights', notes: 'Neutral base with one restrained accent colour.' },
      background: d.backgroundAndProps[0]!,
      textures: 'Matte paper, brushed metal, natural wood grain.',
      pose: d.poseSuggestions.join('; '),
      styling: 'Tailored, minimal accessories, solid colours that do not compete with the product.',
      mood: 'Confident, calm, premium.',
      perImage: req.images.map((img, i) => ({
        assetId: img.assetId,
        notes: img.role === 'product' ? 'Real product photo — treat shape, colour and branding as fixed.' : `Reference ${i + 1}: borrow ${['light quality', 'composition', 'palette', 'pose'][i % 4]}.`,
      })),
    };
    return { value, usage: { inputTokens: 1200 + 800 * req.images.length, outputTokens: 600, estCostUsd: 0 }, model: this.modelFor('text') };
  }

  async generateDirections(req: DirectionsRequest, signal: AbortSignal): Promise<ProviderResult<unknown>> {
    await this.gate(signal);
    const b = req.brief;
    const picks = pickN(DIRECTION_BANK, 3, `${req.seed}:${b.client}:${b.product}`);
    const product = b.product || 'the product';
    const audience = b.audience || 'the target audience';
    const directions: Direction[] = picks.map((p) => ({
      ...p,
      rationale: `${p.title} speaks to ${audience} by framing ${product} as ${p.creativeDirection.split('.')[0]!.toLowerCase()}. Supports the objective: ${b.objective || 'campaign awareness'}.`,
      proposedShots: [
        `Hero: ${product} with talent, wide enough for headline space`,
        `Detail: hands and ${product}, shallow depth of field`,
        `Environmental: talent in set, ${p.backgroundAndProps[0]!.toLowerCase()}`,
        `Social cut-down: vertical crop of the hero`,
      ],
      constraints: [...p.constraints, ...(b.constraints ? [b.constraints] : [])],
    }));
    return { value: { directions }, usage: { inputTokens: 1800, outputTokens: 1400, estCostUsd: 0 }, model: this.modelFor('text') };
  }

  async generateImages(req: ImageRequest, signal: AbortSignal): Promise<ProviderResult<GeneratedImage[]>> {
    await this.gate(signal);
    const { width, height } = aspectToSize(req.aspectRatio, 800);
    const sourceUri = req.kind === 'edit' && req.source ? `data:${req.source.mimeType};base64,${toB64(req.source.bytes)}` : undefined;
    const lightRight = /right/i.test(req.hints.lighting ?? '') && !/camera-left/i.test(req.hints.lighting ?? '');
    const images: GeneratedImage[] = Array.from({ length: req.n }, (_, i) => {
      const svg = drawScene({
        width,
        height,
        palette: req.hints.palette ?? ['#0A0E14', '#1F2A36', '#C9B79C', '#F2EFE9'],
        title: req.hints.title ?? 'Concept',
        subtitle: req.kind === 'pose' ? (req.hints.variationLabels?.[0] ?? 'pose') : `variation ${i + 1} · ${req.aspectRatio} · ${req.quality}`,
        seed: `${req.seed}:${i}`,
        kind: req.kind,
        lightFromRight: lightRight,
        sourceDataUri: sourceUri,
      });
      return { bytes: new TextEncoder().encode(svg), mimeType: 'image/svg+xml', width, height };
    });
    return { value: images, usage: { images: req.n, estCostUsd: 0 }, model: this.modelFor('image') };
  }

  async generateShotPlan(req: ShotPlanRequest, signal: AbortSignal): Promise<ProviderResult<unknown>> {
    await this.gate(signal);
    const d = req.direction ?? { ...DIRECTION_BANK[0]!, rationale: '', proposedShots: ['Hero portrait with product'] };
    const product = req.brief?.product || 'product';
    const priorities = ['must', 'must', 'should', 'should', 'nice', 'nice'] as const;
    const shots = Array.from({ length: req.shotCount }, (_, i) => {
      const lens = LENSES[(i + num(req.seed, 6)) % LENSES.length]!;
      const setup = 15 + ((i * 7 + num(req.seed + i, 20)) % 30);
      return {
        id: `S${String(i + 1).padStart(2, '0')}`,
        priority: priorities[i % priorities.length]!,
        title: d.proposedShots[i % d.proposedShots.length] ?? `Shot ${i + 1}`,
        poseDirection: d.poseSuggestions[i % d.poseSuggestions.length]!,
        cameraAngle: ['Eye level', 'Slightly low', 'Slightly high', '3/4 from left'][i % 4]!,
        framing: ['Three-quarter length', 'Waist-up', 'Tight detail', 'Wide environmental'][i % 4]!,
        lens,
        cameraPosition: `${2 + (i % 3)}.${i % 2 ? 5 : 0} m from subject, lens at ${['chest', 'eye', 'waist'][i % 3]} height`,
        lighting: d.lighting,
        modifiers: ['Octabox 120cm', 'V-flat (black)', 'Strip box 30×120', 'Grid 20°'].slice(0, 2 + (i % 3)),
        background: d.backgroundAndProps[0]!,
        props: d.backgroundAndProps.slice(1),
        productPlacement: i % 2 ? `${product} held at chest height, label to camera` : `${product} on plinth, 15° toward key light`,
        equipment: ['Body + ' + lens, 'Tethering cable', 'C-stands ×3', 'Sandbags ×4'],
        setupMinutes: setup,
        deliverableFormat: i % 3 === 2 ? '9:16 JPEG, 1080×1920, sRGB' : '4:5 TIFF + JPEG, full-res, sRGB',
        referenceAssetId: req.referenceAssetIds.length ? req.referenceAssetIds[i % req.referenceAssetIds.length]! : null,
        approvalStatus: 'pending' as const,
      };
    });
    const value: ShotPlan = {
      summary: `${req.shotCount} shots for "${d.title}". Must-haves first so the hero is in the bag before talent fatigue.`,
      shots,
      equipmentChecklist: ['Camera bodies ×2', ...new Set(shots.map((s) => s.lens)), 'Octabox 120cm', 'Strip boxes ×2', 'V-flats ×2', 'Tether + laptop', 'Colour checker', 'Steamer + styling kit'],
      lightingPlan: d.lighting,
      totalSetupMinutes: shots.reduce((t, s) => t + s.setupMinutes, 0),
      disclaimer: 'Technical settings are recommendations. Adjust lenses, distances and light power on set.',
    };
    return { value, usage: { inputTokens: 1500, outputTokens: 2200, estCostUsd: 0 }, model: this.modelFor('text') };
  }
}
