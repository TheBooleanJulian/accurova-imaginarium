import { describe, expect, it } from 'vitest';
import { packFilename, safe, sgDate } from '@/features/export/pdf';
import type { Project } from '@/core/types';

describe('PDF text safety', () => {
  it('keeps Latin text and typographic marks, maps arrows, flags unsupported scripts', () => {
    expect(safe('Café “Kopi” — 50mm f/2.8 → done')).toBe('Café “Kopi” — 50mm f/2.8 -> done');
    expect(safe('Brief: 无人机 not allowed')).toBe('Brief: ? not allowed');
    expect(safe('ok 😀')).toBe('ok ?');
    expect(safe(null)).toBe('');
  });

  it('builds a readable, safe filename', () => {
    const p = { client: 'Acme Timepieces', name: 'Field Watch — Q1/launch' } as Project;
    expect(packFilename(p, 'final', new Date('2026-10-23T00:00:00Z'))).toBe('accurova-acme-timepieces-field-watch-q1-launch-approved-pack-2026-10-23.pdf');
    expect(packFilename(p, 'draft', new Date('2026-10-23T00:00:00Z'))).toMatch(/-draft-2026-10-23\.pdf$/);
  });

  it('dates packs in Singapore time, not the server clock zone', () => {
    // 22 Oct 17:30 UTC is already 23 Oct 01:30 in Singapore.
    expect(sgDate(new Date('2026-10-22T17:30:00Z'))).toBe('2026-10-23');
  });
});
