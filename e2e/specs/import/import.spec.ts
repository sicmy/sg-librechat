import { expect, test } from '@playwright/test';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('authenticated import persists scoped batches and keeps follow-up chat working', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const source = {
    conversationId: '00000000-0000-4000-8000-000000000011',
    title: 'Scoped batch import fixture',
    endpoint: 'SG AI Gateway',
    options: {
      user: 'untrusted-export-owner',
      tenantId: 'untrusted-export-tenant',
      model: 'default',
    },
    messages: [
      {
        messageId: '00000000-0000-4000-8000-000000000012',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Synthetic imported question.',
        user: 'untrusted-export-owner',
        tenantId: 'untrusted-export-tenant',
        isCreatedByUser: true,
        sender: 'User',
        createdAt: '2026-09-08T00:00:00Z',
      },
      {
        messageId: '00000000-0000-4000-8000-000000000013',
        parentMessageId: '00000000-0000-4000-8000-000000000012',
        text: 'Synthetic imported answer.',
        user: 'untrusted-export-owner',
        tenantId: 'untrusted-export-tenant',
        isCreatedByUser: false,
        sender: 'SG AI Gateway',
        createdAt: '2026-09-08T00:00:01Z',
      },
    ],
  };
  const response = await page.request.post('/api/convos/import', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: {
        name: 'batch-import-fixture.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(source)),
      },
    },
  });
  expect(response.status()).toBe(201);
  const listing = await fetchJson<{ conversations: TConversation[] }>(
    page,
    '/api/convos?limit=25',
    token,
  );
  const imported = listing.conversations.find((convo) => convo.title === source.title)!;
  expect(imported).toBeDefined();
  expect(imported.conversationId).not.toBe(source.conversationId);
  expect(imported.endpoint).toBe('SG AI Gateway');
  const messages = await fetchJson<Array<TMessage & { tenantId?: string }>>(
    page,
    `/api/messages/${imported.conversationId}`,
    token,
  );
  expect(messages.map((message) => message.text)).toEqual(
    source.messages.map((message) => message.text),
  );
  expect(
    messages.every(
      (message) => typeof message.user === 'string' && message.user !== 'untrusted-export-owner',
    ),
  ).toBe(true);
  expect(messages.every((message) => message.tenantId !== 'untrusted-export-tenant')).toBe(true);
  await page.goto(`/c/${imported.conversationId}`);
  await expect(
    page.getByTestId('messages-view').getByText('Synthetic imported answer.', { exact: true }),
  ).toBeVisible();
  await sendMessageAndWaitForCompletion(page, 'Hello');
});
