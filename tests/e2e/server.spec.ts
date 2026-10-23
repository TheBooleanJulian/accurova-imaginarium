import { expect, test } from '@playwright/test';
import { clientReview, createProject, exportFinal, inviteClient, runCampaign } from './flow';

test('server mode: API + Postgres (PGlite) + worker, with a separate client login', async ({ page, browser }) => {
  await page.goto('/');
  await page.locator('input[type=email]').fill('julian@accurova.sg');
  await page.getByRole('button', { name: /Continue/ }).click();
  await createProject(page);
  await runCampaign(page);
  const link = await inviteClient(page, 'client@acme.sg');

  // The client uses their own browser session.
  const clientCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const client = await clientCtx.newPage();
  await client.goto(link);
  await client.getByRole('button', { name: /Continue/ }).click();
  await client.getByRole('button', { name: /Accept and open/ }).click();
  await clientReview(client);
  // Reviewers never get the editor.
  await client.goto(new URL(link).origin + '/#/p/' + client.url().split('/p/')[1]!.split('/')[0]);
  await expect(client.getByTestId('review-page')).toBeVisible();
  await expect(client.locator('.react-flow')).toHaveCount(0);
  await clientCtx.close();

  // The owner sees the decisions arrive (polling) and exports the approved pack.
  await expect(page.getByText(/2 approved/).first()).toBeVisible({ timeout: 30_000 });
  const pdf = await exportFinal(page);
  expect(await pdf.path()).toBeTruthy();
});
