import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import { messagesView, sendMessageAndWaitForCompletion } from '../mock/helpers';

const fixture = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'services/sg-ai-gateway/tests/fixtures/video/maintenance.mp4',
);
const answer =
  'At 0 seconds the gauge is in the red zone and liquid is spilled. Maria brings two filters.';

test('video upload reuses STT and cites only model-selected sampled frames', async ({ page }) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page.locator('input[type="file"]').last().setInputFiles(fixture);
  await expect(
    page
      .getByRole('button', { name: 'maintenance.mp4', exact: true })
      .filter({ hasText: 'Finished analyzing' }),
  ).toBeVisible({ timeout: 30_000 });
  const before = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(before.speech).toHaveLength(1);
  expect(before.vision).toHaveLength(0);
  await sendMessageAndWaitForCompletion(
    page,
    'Describe the visible hazards at the beginning and who brings the filters. Cite the video frame.',
  );
  await expect(messagesView(page).getByText(answer)).toBeVisible();
  const badge = page.getByRole('button', { name: 'Open source 1: maintenance.mp4' });
  await badge.click();
  const panel = page.getByRole('complementary', { name: 'Sources' });
  await expect(panel.getByAltText('Frame 0 of maintenance.mp4')).toBeVisible();
  await expect(panel.getByTestId('sg-citation-highlight')).toBeVisible();
  await expect(panel.getByText('0 seconds · Frame 0').first()).toBeVisible();
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('maintenance.mp4');
  const downloaded = await download.path();
  expect(downloaded).not.toBeNull();
  expect(crypto.createHash('sha256').update(fs.readFileSync(downloaded!)).digest('hex')).toBe(
    crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
  );
  const observations = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observations.vision).toEqual([
    { fixture_id: 'video_maintenance_v1', pixels_match: true, evidence_count: 2 },
  ]);
  expect(observations.speech).toHaveLength(1);
  await page.reload();
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(panel.getByAltText('Frame 0 of maintenance.mp4')).toBeVisible();
});
