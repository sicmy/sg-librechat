import { expect, test } from '@playwright/test';
import type { TFile, TMessage } from 'librechat-data-provider';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('worker finishes interrupted file cleanup without a second delete request', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === conversationId,
  );
  expect(files).toHaveLength(2);
  const root = files.find((file) => file.filename === 'generated-image.png')!;
  const response = await page.request.delete('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      files: [
        { file_id: root.file_id, filepath: root.filepath, source: root.source, embedded: false },
      ],
    },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toBe('synthetic_file_cleanup_failure');
  await expect
    .poll(
      async () => {
        const result = await page.request.get('/api/files', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return ((await result.json()) as TFile[]).filter((file) =>
          files.some((original) => original.file_id === file.file_id),
        ).length;
      },
      { timeout: 15_000 },
    )
    .toBe(0);
  await expect
    .poll(
      async () => {
        const result = await page.request.get(
          `/__e2e/deletion-status?fileId=${encodeURIComponent(root.file_id)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect(result.status()).toBe(200);
        const jobs = (await result.json()) as Array<{ state: string }>;
        return jobs[0]?.state;
      },
      { timeout: 15_000 },
    )
    .toBe('complete');
  const messages = await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
  expect(messages.flatMap((message) => message.metadata?.sgArtifacts?.artifacts ?? [])).toEqual([]);
  await page.reload();
  await expect(
    page
      .getByTestId('messages-view')
      .getByText('Edit image: Make it photorealistic.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Edited image', exact: true })).toHaveCount(0);
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(2);
});
