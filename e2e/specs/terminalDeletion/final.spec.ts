import { expect, test } from '@playwright/test';
import type { TFile } from 'librechat-data-provider';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('FINAL uses refreshed SG metadata when a file is deleted after response persistence', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  const token = await getAccessToken(page);
  const observations = await fetchJson<
    Array<{ fileId: string; responseArtifacts: number; requestFiles: number }>
  >(page, '/__e2e/terminal-observations', token);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ responseArtifacts: 0, requestFiles: 0 });
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (file) => file.file_id === observations[0].fileId,
    ),
  ).toBe(false);
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  await sendMessageAndWaitForCompletion(page, 'Hello');
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(1);
});
