import { expect, test } from '@playwright/test';
import { getAccessToken, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('a real cached job cannot replay under a deleted conversation', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const headers = { Authorization: `Bearer ${await getAccessToken(page)}` };
  expect(
    (
      await page.request.delete('/api/convos', { headers, data: { arg: { conversationId: id } } })
    ).status(),
  ).toBe(201);
  const seed = await page.request.post(`/__e2e/stale-job/${id}`, { headers });
  expect(seed.status()).toBe(200);
  try {
    expect((await seed.json()).cachedEvents).toBeGreaterThan(0);
    for (const route of [`status/${id}`, `stream/${id}`, `stream/${id}?resume=true`]) {
      const response = await page.request.get(`/api/agents/chat/${route}`, {
        headers,
        timeout: 10_000,
      });
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']).not.toContain('text/event-stream');
      expect(await response.text()).not.toContain('synthetic-authorization');
    }
  } finally {
    expect((await page.request.delete(`/__e2e/stale-job/${id}`, { headers })).status()).toBe(204);
  }
});
