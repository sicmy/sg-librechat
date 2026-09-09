import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import { sendMessageAndWaitForCompletion, getAccessToken, fetchJson } from '../mock/helpers';

test('explicit image generation persists a scoped downloadable attachment', async ({ page }) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Hello');
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(0);
  await page.goto('/c/new');
  await page.getByRole('button', { name: 'Create image', exact: true }).click();
  await expect(page.locator('#prompt-textarea')).toHaveValue('Create an image: ');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  const stored = await fetchJson<Array<{ metadata?: object }>>(
    page,
    `/api/messages/${conversationId}`,
    await getAccessToken(page),
  );
  expect(stored.at(-1)?.metadata).toHaveProperty('sgArtifacts');
  const image = page.getByRole('img', { name: 'Generated image' });
  await expect(image).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('generated-image.png');
  const downloaded = await download.path();
  const expected = path.resolve(
    process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
    'services/sg-ai-gateway/tests/fixtures/vision/safety-panel.png',
  );
  expect(crypto.createHash('sha256').update(fs.readFileSync(downloaded!)).digest('hex')).toBe(
    crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'),
  );
  await page.reload();
  await expect(image).toBeVisible();
  const observed = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observed.generation).toEqual([{ image_count: 1, expected_prompt: true }]);
});
