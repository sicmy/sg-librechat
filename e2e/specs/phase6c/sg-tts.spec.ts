import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import { sendMessageAndWaitForCompletion, fetchJson, getAccessToken } from '../mock/helpers';

const fixture = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'services/sg-ai-gateway/tests/fixtures/audio',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(fixture, 'maintenance.expected.json'), 'utf8'),
) as {
  transcript: string;
  sha256: string;
  duration_ms: number;
};

test('explicit TTS returns playable audio and reuses it across identical requests', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Explain speech synthesis.');
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).tts,
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Create speech', exact: true }).click();
  await expect(page.locator('#prompt-textarea')).toHaveValue('Read aloud: ');
  const prompt = `Read aloud: ${manifest.transcript}`;
  await sendMessageAndWaitForCompletion(page, prompt);
  const audio = page.locator('audio[aria-label="Generated speech"]').first();
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).duration))
    .toBeCloseTo(manifest.duration_ms / 1000, 2);
  await audio.evaluate((element) => (element as HTMLAudioElement).play());
  await expect
    .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0);
  await audio.evaluate((element) => (element as HTMLAudioElement).pause());
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('generated-speech.wav');
  expect(
    crypto
      .createHash('sha256')
      .update(fs.readFileSync((await download.path())!))
      .digest('hex'),
  ).toBe(manifest.sha256);
  await page.reload();
  await expect(audio).toBeVisible();
  await sendMessageAndWaitForCompletion(page, prompt);
  await expect(page.locator('audio[aria-label="Generated speech"]')).toHaveCount(2);
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  const messages = await fetchJson<
    Array<{ metadata?: { sgArtifacts?: { artifacts: Array<{ file_id: string }> } } }>
  >(page, `/api/messages/${conversationId}`, await getAccessToken(page));
  const ids = messages.flatMap(
    (message) => message.metadata?.sgArtifacts?.artifacts.map((artifact) => artifact.file_id) ?? [],
  );
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect((await (await page.request.get('http://127.0.0.1:4010/observations')).json()).tts).toEqual(
    [{ expected_text: true, audio_count: 1 }],
  );
});
