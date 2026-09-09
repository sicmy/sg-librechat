import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import { sendMessageAndWaitForCompletion, messagesView } from '../mock/helpers';

const fixtureRoot = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'services/sg-ai-gateway/tests/fixtures/audio',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, 'maintenance.expected.json'), 'utf8'),
) as { file: string; sha256: string; question: string; transcript: string };

test('automatically transcribes an audio upload and reuses timestamp citations after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles(path.join(fixtureRoot, manifest.file));
  await expect(
    page
      .getByRole('button', { name: manifest.file, exact: true })
      .filter({ hasText: 'Finished analyzing' }),
  ).toBeVisible({ timeout: 30_000 });
  const before = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(before.speech).toEqual([{ pcm_match: true, duration_ms: 9965 }]);
  await sendMessageAndWaitForCompletion(page, manifest.question);
  await expect(
    messagesView(page).getByText(
      'Tuesday at 10:00. The blue pump needs a filter. Maria brings two replacement filters.',
    ),
  ).toBeVisible();
  const badge = page.getByRole('button', { name: 'Open source 1: maintenance.wav' }).last();
  await badge.click();
  const panel = page.getByRole('complementary', { name: 'Sources' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('0–10 seconds').first()).toBeVisible();
  await expect(panel.getByText(manifest.transcript).first()).toBeVisible();
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(manifest.file);
  const downloaded = await download.path();
  expect(downloaded).not.toBeNull();
  expect(crypto.createHash('sha256').update(fs.readFileSync(downloaded!)).digest('hex')).toBe(
    manifest.sha256,
  );
  await page.reload();
  await expect(badge).toBeVisible();
  await sendMessageAndWaitForCompletion(page, 'Who brings the filters?');
  const after = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(after.speech).toHaveLength(1);
  expect(after.chat).toHaveLength(2);
});
