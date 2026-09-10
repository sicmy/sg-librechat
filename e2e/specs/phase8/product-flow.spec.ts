import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import { fetchJson, getAccessToken, sendMessageAndWaitForCompletion } from '../mock/helpers';

const fixtureRoot = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'services/sg-ai-gateway/tests/fixtures',
);
const speech = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, 'audio/maintenance.expected.json'), 'utf8'),
) as { transcript: string; duration_ms: number };

test('keeps document citations and generated media consistent across one conversation and reload', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  const filename = 'product-flow.txt';
  const text = 'DIRECT_ALPHA is the approved direct-context value.';
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from(text),
    });
  await expect(
    page
      .getByRole('button', { name: filename, exact: true })
      .filter({ hasText: 'Finished analyzing' }),
  ).toBeVisible({ timeout: 30_000 });
  await sendMessageAndWaitForCompletion(page, 'Return DIRECT_ALPHA from the attached file.');
  await expect(page.getByText('Direct answer: DIRECT_ALPHA.', { exact: true })).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  expect(conversationId).toBeTruthy();
  const citation = page.getByRole('button', { name: `Open source 1: ${filename}`, exact: true });
  await expect(citation).toBeVisible();

  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  await expect(page.getByRole('img', { name: 'Edited image', exact: true })).toBeVisible();
  await sendMessageAndWaitForCompletion(page, `Read aloud: ${speech.transcript}`);
  const audio = page.locator('audio[aria-label="Generated speech"]');
  await expect(audio).toHaveCount(1);
  await expect
    .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).duration))
    .toBeCloseTo(speech.duration_ms / 1000, 2);
  await audio.evaluate((element) => (element as HTMLAudioElement).play());
  await expect
    .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0);
  await audio.evaluate((element) => (element as HTMLAudioElement).pause());
  expect(new URL(page.url()).pathname.split('/').at(-1)).toBe(conversationId);

  const readMessages = async () =>
    fetchJson<TMessage[]>(
      page,
      `/api/messages/${encodeURIComponent(conversationId ?? '')}`,
      await getAccessToken(page),
    );
  const before = await readMessages();
  const artifacts = before.flatMap((message) => message.metadata?.sgArtifacts?.artifacts ?? []);
  expect(artifacts).toHaveLength(3);
  expect(new Set(artifacts.map((artifact) => artifact.file_id)).size).toBe(3);
  expect(artifacts[1].source_file_id).toBe(artifacts[0].file_id);
  expect(artifacts[2].mime_type).toBe('audio/wav');

  await page.reload();
  await expect(citation).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Edited image', exact: true })).toBeVisible();
  await expect(audio).toBeVisible();
  const after = await readMessages();
  expect(after.flatMap((message) => message.metadata?.sgArtifacts?.artifacts ?? [])).toEqual(
    artifacts,
  );

  const expectedFiles = [
    'vision/safety-panel.png',
    'vision/safety-panel.realistic.png',
    'audio/maintenance.wav',
  ];
  for (const [index, artifact] of artifacts.entries()) {
    const figure = page
      .locator('figure')
      .filter({ has: page.locator('figcaption').filter({ hasText: artifact.display_name }) });
    const downloading = page.waitForEvent('download');
    await figure.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    const downloaded = await download.path();
    if (!downloaded) throw new Error('Download did not produce a file');
    expect(download.suggestedFilename()).toBe(artifact.display_name);
    expect(crypto.createHash('sha256').update(fs.readFileSync(downloaded)).digest('hex')).toBe(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(fixtureRoot, expectedFiles[index])))
        .digest('hex'),
    );
  }
  await citation.click();
  const sources = page.getByRole('complementary', { name: 'Sources' });
  await expect(sources).toBeVisible();
  await expect(sources.getByText(text, { exact: true }).first()).toBeVisible();
  const observations = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observations.generation).toHaveLength(2);
  expect(observations.tts).toEqual([{ expected_text: true, audio_count: 1 }]);
});
