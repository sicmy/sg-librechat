import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import type { TFile, TMessage } from 'librechat-data-provider';
import { fetchJson, getAccessToken, sendMessageAndWaitForCompletion } from '../mock/helpers';

const audio = JSON.parse(
  fs.readFileSync(
    path.resolve(
      process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
      'services/sg-ai-gateway/tests/fixtures/audio/maintenance.expected.json',
    ),
    'utf8',
  ),
) as { transcript: string };

test('deleting one generated source removes its edit and references while preserving unrelated speech', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  await sendMessageAndWaitForCompletion(page, `Read aloud: ${audio.transcript}`);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === id,
  );
  expect(files).toHaveLength(3);
  const original = files.find((file) => file.filename === 'generated-image.png')!;
  const edited = files.find((file) => file.filename === 'edited-image.png')!;
  const speech = files.find((file) => file.type === 'audio/wav')!;
  const response = await page.request.delete('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      files: [
        {
          file_id: original.file_id,
          filepath: original.filepath,
          source: original.source,
          embedded: false,
        },
      ],
    },
  });
  expect(response.status()).toBe(200);
  expect(new Set((await response.json()).deleted_file_ids)).toEqual(
    new Set([original.file_id, edited.file_id]),
  );
  await page.reload();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Edited image', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Generated speech', { exact: true })).toBeVisible();
  const messages = await page.request.get(`/api/messages/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const artifacts = ((await messages.json()) as TMessage[]).flatMap(
    (message) => message.metadata?.sgArtifacts?.artifacts ?? [],
  );
  expect(artifacts.map((artifact) => artifact.file_id)).toEqual([speech.file_id]);
  for (const file of [original, edited]) {
    expect([403, 404]).toContain(
      (
        await page.request.get(`/api/files/sg-citation/${file.file_id}/download`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status(),
    );
  }
  await sendMessageAndWaitForCompletion(page, 'Hello');
  const observed = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observed.generation).toHaveLength(2);
  expect(observed.tts).toHaveLength(1);
});
