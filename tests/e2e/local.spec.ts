import { expect, test } from '@playwright/test';
import { clientReview, createProject, exportFinal, inviteClient, runCampaign } from './flow';

test('browser-only demo: brief → concepts → client approval → final PDF', async ({ page }) => {
  await page.goto('/');
  await createProject(page);
  await runCampaign(page);
  const link = await inviteClient(page, 'client@acme.sg');

  // Same browser, different account: open the invite and sign in as the client.
  await page.goto(link);
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByRole('button', { name: /Accept and open/ }).click();
  await clientReview(page);

  // Back to the owner via the account switcher.
  await page.getByRole('button', { name: /client/ }).first().click();
  await page.getByRole('button', { name: /Julian/ }).click();
  await page.locator('button', { hasText: 'Field Watch' }).first().click();
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
  await exportFinal(page);
});
