import type { Brief, Direction, ReferenceAnalysis } from './schemas';
import type { TextValue } from './graph';

/**
 * Prompt templates. Versioned through OperationDef.promptVersion — bump that
 * when a template changes so existing outputs are flagged stale.
 */

const FIDELITY_RULES = [
  'Images marked PRODUCT are real photographs of the actual product: preserve its shape, proportions, materials, colours, logos and text exactly.',
  'Images marked REFERENCE are inspiration only: borrow mood, light and composition, never copy people, logos or trademarks.',
  'Never invent product features, claims, packaging text or specifications that are not visible in a PRODUCT image or stated in the brief.',
].join('\n');

export function briefText(b: Brief | null | undefined): string {
  if (!b) return '(no brief connected)';
  return [
    `Client: ${b.client || '—'}`,
    `Product: ${b.product || '—'}`,
    `Audience: ${b.audience || '—'}`,
    `Objective: ${b.objective || '—'}`,
    `Visual style: ${b.visualStyle || '—'}`,
    `Deliverables: ${b.deliverables || '—'}`,
    `Constraints: ${b.constraints || '—'}`,
  ].join('\n');
}

export function analysisPrompt(brief: Brief | null, focus: string[], notes: string, imageRoles: string[]): string {
  return `You are the senior art director at Accurova, a premium corporate photography studio in Singapore.
Analyse the attached images (${imageRoles.map((r, i) => `#${i + 1}=${r.toUpperCase()}`).join(', ')}) for a preshoot moodboard.
Focus on: ${focus.join(', ')}.
Describe what a photographer could physically reproduce: light direction and quality (hard/soft, key/fill ratio), framing and lens feel, colour palette as hex codes, contrast, background, textures and materials, subject pose and placement, styling and mood.
${notes ? `Extra notes from the photographer: ${notes}\n` : ''}
Campaign brief:
${briefText(brief)}

Return JSON only, matching the provided schema. perImage notes must reference the given asset ids.`;
}

export function directionsPrompt(brief: Brief, analysis: ReferenceAnalysis | null, notes: TextValue[], guidance: string): string {
  return `You are the creative director at Accurova, a premium corporate photography studio in Singapore.
Propose exactly THREE clearly distinct creative directions for this campaign shoot. They must differ in concept, palette and lighting, not just wording, and each must be achievable in a real studio or location shoot in Singapore within a single day.

Campaign brief:
${briefText(brief)}
${analysis ? `\nReference analysis:\n${analysis.summary}\nLighting: ${analysis.lighting}\nComposition: ${analysis.composition}\nPalette: ${analysis.colour.palette.join(', ')}\nMood: ${analysis.mood}` : ''}
${notes.length ? `\nArt-direction notes:\n${notes.map((n) => `- ${n.title}: ${n.text}`).join('\n')}` : ''}
${guidance ? `\nAdditional guidance: ${guidance}` : ''}

${FIDELITY_RULES}

For each direction give: title, rationale, creativeDirection, palette (hex codes), lighting, proposedShots, poseSuggestions, backgroundAndProps, constraints and negativeInstructions (what to avoid). Return JSON only.`;
}

export function conceptImagePrompt(brief: Brief | null, d: Direction, override: string): string {
  if (override.trim()) return `${override.trim()}\n\n${FIDELITY_RULES}`;
  return `Photographic campaign concept for ${brief?.client || 'the client'} — "${d.title}".
${d.creativeDirection}
Lighting: ${d.lighting}
Palette: ${d.palette.join(', ')}
Set: ${d.backgroundAndProps.join('; ')}
Pose: ${d.poseSuggestions[0] ?? ''}
Shot: ${d.proposedShots[0] ?? ''}
Avoid: ${[...d.negativeInstructions, 'watermarks', 'extra logos', 'distorted hands'].join(', ')}
Style: realistic commercial photograph, premium corporate finish, achievable with real studio lighting.
${FIDELITY_RULES}`;
}

export function posePrompt(change: string[], keep: string[], notes: string, d: Direction | null, label: string): string {
  return `Create a pose variation of the source image for a photoshoot reference.
CHANGE ONLY: ${change.join(', ')}. This variation: ${label}.
KEEP IDENTICAL: ${keep.join(', ')}.
${d ? `Creative direction: ${d.title} — pose ideas: ${d.poseSuggestions.join('; ')}` : ''}
${notes ? `Notes: ${notes}` : ''}
Natural, anatomically correct hands and posture. This is a pose reference, not a final photograph.
${FIDELITY_RULES}`;
}

export function editPrompt(instruction: string, preserve: string[]): string {
  return `Edit the source image: ${instruction}
Preserve exactly: ${preserve.join(', ')}.
Change nothing else.
${FIDELITY_RULES}`;
}

export function shotPlanPrompt(brief: Brief | null, d: Direction | null, shotCount: number, gear: string, notes: string, refIds: string[]): string {
  return `You are the lead photographer at Accurova planning a real shoot in Singapore.
Write a practical shot plan with ${shotCount} shots.
${briefText(brief)}
${d ? `\nApproved direction: ${d.title}\n${d.creativeDirection}\nLighting: ${d.lighting}\nPalette: ${d.palette.join(', ')}` : ''}
${gear ? `\nAvailable gear / constraints: ${gear}` : ''}
${notes ? `\nNotes: ${notes}` : ''}
Approved reference image ids (link each shot to the most relevant one via referenceAssetId, or null): ${refIds.join(', ') || 'none'}

For each shot: id (S01…), priority (must/should/nice), title, poseDirection, cameraAngle, framing, lens (focal length + aperture), cameraPosition, lighting (direction + placement), modifiers, background, props, productPlacement, equipment, setupMinutes, deliverableFormat, referenceAssetId, approvalStatus "pending".
Also: summary, equipmentChecklist, lightingPlan, totalSetupMinutes, and a disclaimer that technical settings are recommendations for the photographer to adjust on set.
Return JSON only.`;
}
