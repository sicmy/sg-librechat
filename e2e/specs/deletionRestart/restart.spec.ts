import { expect, test } from '@playwright/test';
import type { TFile } from 'librechat-data-provider';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

type SupervisorState = {
  expiryBodies: number;
  expiryReferences: number;
  lateRows: number;
  lateConversations: number;
  lateMessages: number;
  pid: number;
  generation: number;
  exited: boolean;
  tools: number;
  shares: number;
  jobs: Array<{
    resourceIds: string[];
    state: string;
    attempts: number;
    remoteComplete: boolean;
    leaseUntil?: string | null;
    reconcileAttempts?: number;
  }>;
};
const controlHeaders = { 'x-e2e-control': 'synthetic-restart-control' };
test('new Node process resumes durable conversation deletion against the same Mongo database', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = async () => {
    const response = await page.request.get('http://127.0.0.1:4030/status', {
      headers: controlHeaders,
    });
    expect(response.status()).toBe(200);
    return (await response.json()) as SupervisorState;
  };
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.', {
    timeout: 45_000,
  });
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  expect(
    (
      await page.request.post(`http://127.0.0.1:4030/seed?conversationId=${conversationId}`, {
        headers: controlHeaders,
      })
    ).status(),
  ).toBe(200);
  const original = await state();
  expect((await page.request.get('http://127.0.0.1:4030/status')).status()).toBe(403);
  expect(
    (
      await page.request.post('http://127.0.0.1:4030/restart', { headers: controlHeaders })
    ).status(),
  ).toBe(409);
  expect(original).toMatchObject({ generation: 1, exited: false, tools: 1, shares: 1 });
  await page.request
    .delete('/api/convos', { headers, data: { arg: { conversationId } }, timeout: 15_000 })
    .catch(() => undefined);
  await expect.poll(async () => (await state()).exited, { timeout: 15_000 }).toBe(true);
  const stopped = await state();
  expect(stopped.jobs).toHaveLength(1);
  expect(stopped.jobs[0]).toMatchObject({
    state: 'pending',
    remoteComplete: true,
    attempts: 1,
    resourceIds: [conversationId],
  });
  expect(stopped).toMatchObject({ tools: 1, shares: 1 });
  expect(
    (
      await page.request.post('http://127.0.0.1:4030/restart', { headers: controlHeaders })
    ).status(),
  ).toBe(200);
  await expect
    .poll(
      async () => {
        const status = await state();
        return { state: status.jobs[0]?.state, tools: status.tools, shares: status.shares };
      },
      { timeout: 45_000 },
    )
    .toEqual({ state: 'complete', tools: 0, shares: 0 });
  const resumed = await state();
  expect(resumed.generation).toBe(2);
  expect(resumed.pid).not.toBe(original.pid);
  expect(resumed.jobs[0].attempts).toBe(2);
  await expect
    .poll(async () => (await page.request.get('/readyz')).status(), { timeout: 15_000 })
    .toBe(200);
  expect((await page.request.get(`/api/convos/${conversationId}`, { headers })).status()).toBe(404);
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
      (file) => file.conversationId === conversationId,
    ),
  ).toEqual([]);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Hello');
  const keptConversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(
    (
      await page.request.post('http://127.0.0.1:4030/stop-child', { headers: controlHeaders })
    ).status(),
  ).toBe(200);
  expect((await state()).exited).toBe(true);
  expect(
    (
      await page.request.post(`http://127.0.0.1:4030/seed-late?conversationId=${conversationId}`, {
        headers: controlHeaders,
      })
    ).status(),
  ).toBe(200);
  expect(await state()).toMatchObject({
    expiryBodies: 1,
    expiryReferences: 0,
    lateRows: 1,
    lateConversations: 1,
    lateMessages: 1,
    tools: 1,
    shares: 1,
  });
  expect(
    (
      await page.request.post('http://127.0.0.1:4030/restart', { headers: controlHeaders })
    ).status(),
  ).toBe(200);
  await expect
    .poll(
      async () => {
        const status = await state();
        return {
          lateRows: status.lateRows,
          expiryBodies: status.expiryBodies,
          expiryReferences: status.expiryReferences,
          lateConversations: status.lateConversations,
          lateMessages: status.lateMessages,
          tools: status.tools,
          shares: status.shares,
          leaseUntil: status.jobs[0]?.leaseUntil,
        };
      },
      { timeout: 45_000 },
    )
    .toEqual({
      expiryBodies: 0,
      expiryReferences: 1,
      lateRows: 0,
      lateConversations: 0,
      lateMessages: 0,
      tools: 0,
      shares: 0,
      leaseUntil: null,
    });
  const reconciled = await state();
  expect(reconciled.generation).toBe(3);
  expect(reconciled.pid).not.toBe(resumed.pid);
  expect(reconciled.jobs[0]).toMatchObject({ state: 'complete', attempts: 2 });
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get('/readyz')).status();
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(200);
  expect((await page.request.get(`/api/convos/${conversationId}`, { headers })).status()).toBe(404);
  expect((await page.request.get(`/api/convos/${keptConversationId}`, { headers })).status()).toBe(
    200,
  );
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(1);
});
