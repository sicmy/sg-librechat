import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { toSGScopeToken } from '@librechat/api';
import type { TFile, TMessage } from 'librechat-data-provider';
import { fetchJson, getAccessToken, sendMessageAndWaitForCompletion } from '../mock/helpers';

test.beforeEach(async ({ page }) => {
  await page.request.delete('http://127.0.0.1:4010/observations');
});

const audio = JSON.parse(
  fs.readFileSync(
    path.resolve(
      process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
      'services/sg-ai-gateway/tests/fixtures/audio/maintenance.expected.json',
    ),
    'utf8',
  ),
) as { transcript: string };

function headers(file: TFile) {
  return {
    Authorization: 'Bearer e2e-gateway-key',
    'X-SG-User-ID': String(file.user),
    'X-SG-Tenant-ID': toSGScopeToken(undefined, 'tenant'),
    'X-SG-Conversation-ID': file.metadata!.sgGateway!.conversationId,
  };
}

test('deleting a generated-only chat removes original, edit, messages and Gateway access', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await sendMessageAndWaitForCompletion(page, 'Edit image: Make it photorealistic.');
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === id,
  );
  expect(files).toHaveLength(2);
  for (const file of files) {
    const before = await page.request.get(
      `http://127.0.0.1:4020/internal/files/${file.file_id}/download`,
      { headers: headers(file) },
    );
    expect(before.status()).toBe(200);
  }
  await page.getByRole('button', { name: 'New Chat conversation', exact: true }).first().hover();
  await page.getByRole('button', { name: 'Conversation Menu Options' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const deleting = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && response.url().includes('/api/convos'),
  );
  await page
    .getByRole('dialog', { name: 'Delete chat?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  expect((await deleting).status()).toBe(201);
  for (const suffix of [`status/${id}`, `stream/${id}`, `stream/${id}?resume=true`]) {
    const replay = await page.request.get(`/api/agents/chat/${suffix}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    expect(replay.status()).toBe(404);
    expect(replay.headers()['content-type']).not.toContain('text/event-stream');
  }
  await expect(page).toHaveURL(/\/c\/new/);
  const remaining = await page.request.get('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const remainingIds = ((await remaining.json()) as TFile[]).map((file) => file.file_id);
  for (const file of files) {
    expect(remainingIds).not.toContain(file.file_id);
    expect(
      (
        await page.request.get(`http://127.0.0.1:4020/internal/files/${file.file_id}/download`, {
          headers: headers(file),
        })
      ).status(),
    ).toBe(404);
  }
  const messages = await page.request.get(`/api/messages?conversationId=${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(((await messages.json()) as { messages: TMessage[] }).messages).toEqual([]);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Edited image', exact: true })).toHaveCount(0);
  const observed = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observed.generation).toHaveLength(2);
});

test('delete-all cleans image and TTS files from every selected conversation', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  const first = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('link', { name: 'New chat', exact: true }).click();
  await sendMessageAndWaitForCompletion(page, `Read aloud: ${audio.transcript}`);
  const second = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter((file) =>
    [first, second].includes(file.conversationId!),
  );
  expect(files).toHaveLength(2);
  const deleted = await page.request.delete('/api/convos/all', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleted.status()).toBe(201);
  expect((await deleted.json()).conversationIds).toEqual(expect.arrayContaining([first, second]));
  const remaining = await page.request.get('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    ((await remaining.json()) as TFile[]).filter((file) =>
      [first, second].includes(file.conversationId!),
    ),
  ).toEqual([]);
  for (const file of files) {
    expect(
      (
        await page.request.get(`http://127.0.0.1:4020/internal/files/${file.file_id}/download`, {
          headers: headers(file),
        })
      ).status(),
    ).toBe(404);
  }
  await page.reload();
  await expect(page.getByLabel('Generated speech', { exact: true })).toHaveCount(0);
  const observed = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
  expect(observed.generation).toHaveLength(1);
  expect(observed.tts).toHaveLength(1);
});
