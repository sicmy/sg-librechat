import { expect, test } from '@playwright/test';
import type { TFile } from 'librechat-data-provider';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('conversation cleanup resumes after its row is deleted without another delete request', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === conversationId,
  );
  expect(files).toHaveLength(1);
  const response = await page.request.delete('/api/convos', {
    headers,
    data: { arg: { conversationId } },
  });
  expect(response.status()).toBe(500);
  expect((await page.request.get(`/api/convos/${conversationId}`, { headers })).status()).toBe(404);
  expect((await page.request.get(`/api/messages/${conversationId}`, { headers })).status()).toBe(
    404,
  );
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (file) => file.file_id === files[0].file_id,
    ),
  ).toBe(false);
  await expect
    .poll(
      async () => {
        const status = await page.request.get(
          `/__e2e/deletion-status?conversationId=${encodeURIComponent(conversationId)}`,
          { headers },
        );
        expect(status.status()).toBe(200);
        const jobs = (await status.json()) as Array<{
          resourceIds: string[];
          state: string;
          attempts: number;
        }>;
        return jobs.find((job) => job.resourceIds.includes(conversationId));
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ state: 'complete', attempts: 2 });
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Hello');
  expect(new URL(page.url()).pathname).not.toContain(conversationId);
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(1);
});
