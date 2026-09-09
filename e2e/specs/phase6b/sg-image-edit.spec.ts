import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import { sendMessageAndWaitForCompletion, fetchJson, getAccessToken } from '../mock/helpers';

type Artifact = { file_id: string; source_file_id?: string | null };
type Message = { metadata?: { sgArtifacts?: { artifacts: Artifact[] } } };

test('edits the generated source in the active branch and preserves both files after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit image', exact: true }).click();
  await expect(page.locator('#prompt-textarea')).toHaveValue('Edit image: ');
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  const edited = page.getByRole('img', { name: 'Edited image', exact: true });
  await expect(edited).toBeVisible();
  await page.getByRole('button', { name: 'Source image', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Source image', exact: true })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  const messages = await fetchJson<Message[]>(
    page,
    `/api/messages/${conversationId}`,
    await getAccessToken(page),
  );
  const artifacts = messages.flatMap((message) => message.metadata?.sgArtifacts?.artifacts ?? []);
  expect(artifacts).toHaveLength(2);
  expect(artifacts[1].source_file_id).toBe(artifacts[0].file_id);
  expect(artifacts[1].file_id).not.toBe(artifacts[0].file_id);
  const downloading = page.waitForEvent('download');
  await edited
    .locator('xpath=ancestor::figure')
    .getByRole('button', { name: 'Download', exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('edited-image.png');
  const downloaded = await download.path();
  const fixture = path.resolve(
    process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
    'services/sg-ai-gateway/tests/fixtures/vision/safety-panel.realistic.png',
  );
  expect(crypto.createHash('sha256').update(fs.readFileSync(downloaded!)).digest('hex')).toBe(
    crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
  );
  await page.reload();
  await expect(edited).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  const observations = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observations.generation).toHaveLength(2);
  expect(observations.generation[1]).toEqual({
    image_count: 1,
    source_matches: true,
    is_edit: true,
    expected_prompt: true,
  });
});
