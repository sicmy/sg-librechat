import { expect, test } from '@playwright/test';
import { getAccessToken, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('file-only deletion filters cached status, SYNC and repeated FINAL delivery', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const headers = { Authorization: `Bearer ${await getAccessToken(page)}` };
  const seed = await page.request.post(`/__e2e/file-cache/${id}`, { headers });
  expect(seed.status()).toBe(200);
  const fixture = (await seed.json()) as { removed: string; kept: string; cachedFiles: number };
  try {
    expect(fixture.cachedFiles).toBe(2);
    const status = await page.request.get(`/api/agents/chat/status/${id}`, { headers });
    expect(status.status()).toBe(200);
    const state = await status.json();
    expect(state.resumeState.userMessage.files).toEqual([{ file_id: fixture.kept }]);
    const stream = page.request.get(`/api/agents/chat/stream/${id}?resume=true`, {
      headers,
      timeout: 15_000,
    });
    const published = await page.request.post(`/__e2e/file-cache/${id}/publish`, {
      headers,
      timeout: 15_000,
    });
    expect(published.status()).toBe(200);
    expect((await published.json()).cachedArtifacts).toBe(1);
    const first = await stream;
    expect(first.status()).toBe(200);
    const body = await first.text();
    expect(body).toContain('"sync":true');
    expect(body).toContain('"final":true');
    expect(body).toContain(fixture.kept);
    expect(body).not.toContain(fixture.removed);
    const replay = await page.request.get(`/api/agents/chat/stream/${id}`, {
      headers,
      timeout: 15_000,
    });
    expect(replay.status()).toBe(200);
    const again = await replay.text();
    expect(again).toContain('"final":true');
    expect(again).not.toContain(fixture.removed);
  } finally {
    expect((await page.request.delete(`/__e2e/file-cache/${id}`, { headers })).status()).toBe(204);
  }
});
