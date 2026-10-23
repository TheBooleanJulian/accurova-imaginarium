import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export const fixture = (f: string) => path.join(import.meta.dirname, 'fixtures', f);

export function editor(page: Page) {
  const insp = page.getByTestId('inspector');
  return {
    insp,
    node: (title: string) => page.locator('.react-flow__node').filter({ hasText: title }).first(),
    async run(label: string) {
      const card = insp.locator('div.rounded-lg.border', { hasText: label }).first();
      await card.getByRole('button', { name: /^(Run|Regenerate)$/ }).click();
      await expect(card.getByText(/up to date/i)).toBeVisible({ timeout: 60_000 });
    },
  };
}

export async function createProject(page: Page) {
  await page.getByRole('button', { name: /New project|Create your first/ }).first().click();
  await page.getByPlaceholder('e.g. Acme Field Watch — Q1 launch').fill('Field Watch — Q1 launch');
  await page.getByPlaceholder('Company').fill('Acme Timepieces');
  await page.getByPlaceholder('What we’re shooting').fill('Field Watch 40mm');
  await page.getByPlaceholder('What should this shoot achieve?').fill('Launch to urban professionals');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
}

/** Uploads, analysis, directions, concepts, poses, shot plan. */
export async function runCampaign(page: Page) {
  const e = editor(page);
  await e.node('Product photos').click();
  await e.insp.locator('input[type=file]').setInputFiles(fixture('product.jpg'));
  await expect(e.insp.getByText('Real product', { exact: true })).toHaveCount(1);
  await e.node('Inspiration').click();
  await e.insp.locator('input[type=file]').setInputFiles([fixture('reference.png'), fixture('reference2.webp')]);
  await expect(e.insp.getByText('Reference', { exact: true })).toHaveCount(2);

  await e.node('Reference analysis').click();
  await e.run('Analyse references');
  await e.node('Concept generator').click();
  await e.run('Generate 3 directions');
  await e.insp.locator('button', { hasText: /Quiet Authority|Golden Hour|Monochrome|Tropical|Kinetic/ }).first().click();
  await e.run('Render concept images');
  await expect(e.insp.getByText('AI concept', { exact: true }).first()).toBeVisible();
  await e.node('Pose variations').click();
  await e.run('Generate pose variations');
  await e.node('Shot planner').click();
  await e.run('Generate shot plan');
  await expect(e.insp.getByText('S01')).toBeVisible();
}

export async function inviteClient(page: Page, email: string): Promise<string> {
  await page.getByRole('button', { name: /^Share$/ }).click();
  await page.getByPlaceholder('client@company.com').fill(email);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.locator('span.font-mono', { hasText: '/invite/' }).first().innerText();
  await page.keyboard.press('Escape');
  return link;
}

/** As the client: approve two items, request changes on one. */
export async function clientReview(page: Page) {
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByText(/0 of \d+ approved/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve$/ }).first().click();
  await expect(page.getByText(/1 of \d+ approved/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve$/ }).first().click();
  await expect(page.getByText(/2 of \d+ approved/)).toBeVisible();
  await page.getByRole('button', { name: /^Comment$/ }).first().click();
  await page.getByPlaceholder(/Add a note/).fill('Warmer backdrop please');
  await page.getByRole('button', { name: /Request changes/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/changes requested/).first()).toBeVisible();
}

export async function exportFinal(page: Page) {
  await page.getByRole('button', { name: /^Export$/ }).click();
  await page.getByText('Final approved pack').click();
  await page.getByRole('button', { name: /Export final PDF/ }).click();
  const row = page.locator('div.rounded-lg', { hasText: 'approved-pack' }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Download PDF' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/approved-pack.*\.pdf$/);
  return d;
}
