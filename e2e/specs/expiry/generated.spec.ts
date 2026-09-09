import { expect, test } from '@playwright/test';
import type { TFile } from 'librechat-data-provider';
import { toSGScopeToken } from '@librechat/api';
import { getAccessToken, fetchJson, sendMessageAndWaitForCompletion } from '../mock/helpers';

test('expired message bodies disappear while file IDs survive until conversation cleanup', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const file = (await fetchJson<TFile[]>(page, '/api/files', token)).find(
    (entry) => entry.conversationId === id,
  )!;
  expect(file).toBeTruthy();
  const compacted = await page.request.post(`/__e2e/expire-messages/${id}`, { headers });
  expect(compacted.status()).toBe(200);
  expect(await compacted.json()).toMatchObject({
    compacted: 2,
    retained: 2,
    withContent: 0,
    references: 1,
    orphaned: 0,
    failed: 0,
  });
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  const expired = await page.request.post(`/__e2e/expire-conversation/${id}`, { headers });
  expect(expired.status()).toBe(200);
  expect(await expired.json()).toMatchObject({ deleted: 1, failed: 0, state: 'complete' });
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(false);
  expect([403, 404]).toContain(
    (
      await page.request.get(`/api/files/sg-citation/${file.file_id}/download`, { headers })
    ).status(),
  );
});

test('an analyzed but unsent SG upload keeps its expiry and deletes the Gateway original when abandoned', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/c/new');
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: 'abandoned-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('DIRECT_ALPHA is the abandoned upload fixture fact.'),
    });
  const token = await getAccessToken(page);
  await expect
    .poll(
      async () => {
        const rows = await fetchJson<TFile[]>(page, '/api/files', token);
        const uploaded = rows.find((entry) => entry.filename === 'abandoned-upload.txt');
        if (!uploaded) return 'missing';
        const preview = await fetchJson<{ status: string; previewError?: string }>(
          page,
          `/api/files/${uploaded.file_id}/preview`,
          token,
        );
        return preview.status === 'failed' ? `failed:${preview.previewError}` : preview.status;
      },
      { timeout: 15_000 },
    )
    .toBe('ready');
  await expect(
    page.getByRole('button', { name: 'abandoned-upload.txt', exact: true }),
  ).toContainText('Finished analyzing', { timeout: 30_000 });
  const headers = { Authorization: `Bearer ${token}` };
  const files = await fetchJson<Array<TFile & { sgUploadExpiresAt?: string; expiresAt?: string }>>(
    page,
    '/api/files',
    token,
  );
  const file = files.find((entry) => entry.filename === 'abandoned-upload.txt')!;
  expect(file).toBeTruthy();
  expect(file.expiresAt).toBeUndefined();
  expect(file.sgUploadExpiresAt).toBeTruthy();
  const gatewayDownload = `http://127.0.0.1:4020/internal/files/${file.file_id}/download`;
  const gatewayHeaders = {
    Authorization: 'Bearer e2e-gateway-key',
    'X-SG-User-ID': toSGScopeToken(String(file.user), 'user'),
    'X-SG-Tenant-ID': toSGScopeToken(file.tenantId, 'tenant'),
    'X-SG-Conversation-ID': file.metadata!.sgGateway!.conversationId,
  };
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(200);
  const expired = await page.request.post(`/__e2e/expire-file/${file.file_id}?upload=true`, {
    headers,
  });
  expect(expired.status()).toBe(200);
  expect(await expired.json()).toMatchObject({
    scanned: 1,
    deleted: 1,
    failed: 0,
    state: 'complete',
  });
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(404);
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(false);
});

test('conversation expiry cleans generated originals and remains deleted after browser reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === id,
  );
  expect(files).toHaveLength(1);
  const file = files[0];
  const download = `/api/files/sg-citation/${file.file_id}/download`;
  const gatewayDownload = `http://127.0.0.1:4020/internal/files/${file.file_id}/download`;
  const gatewayHeaders = {
    Authorization: 'Bearer e2e-gateway-key',
    'X-SG-User-ID': toSGScopeToken(String(file.user), 'user'),
    'X-SG-Tenant-ID': toSGScopeToken(file.tenantId, 'tenant'),
    'X-SG-Conversation-ID': file.metadata!.sgGateway!.conversationId,
  };
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(200);
  expect((await page.request.get(download, { headers })).status()).toBe(200);
  const expired = await page.request.post(`/__e2e/expire-conversation/${id}`, { headers });
  expect(expired.status()).toBe(200);
  expect(await expired.json()).toMatchObject({
    scanned: 1,
    deleted: 1,
    failed: 0,
    before: 1,
    after: 0,
    state: 'complete',
  });
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(404);
  expect([403, 404]).toContain((await page.request.get(download, { headers })).status());
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated image', exact: true })).toHaveCount(0);
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Hello');
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(1);
});

test('temporary SG generation receives a deadline and expiry uses the durable deletion path', async ({
  page,
}) => {
  test.setTimeout(90_000);
  let markedTemporary = 0;
  await page.route('**/api/agents/chat**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const data = route.request().postDataJSON();
    if (typeof data?.text !== 'string') {
      await route.continue();
      return;
    }
    markedTemporary++;
    await route.continue({ postData: JSON.stringify({ ...data, isTemporary: true }) });
  });
  await page.request.delete('http://127.0.0.1:4010/observations');
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, 'Create an image: An industrial safety panel.');
  expect(markedTemporary).toBe(1);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const token = await getAccessToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const files = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (file) => file.conversationId === id,
  );
  expect(files).toHaveLength(1);
  const file = files[0];
  expect(file.expiredAt).toBeTruthy();
  expect(new Date(String(file.expiredAt)).getTime()).toBeGreaterThan(Date.now());
  const download = `/api/files/sg-citation/${file.file_id}/download`;
  const gatewayDownload = `http://127.0.0.1:4020/internal/files/${file.file_id}/download`;
  const gatewayHeaders = {
    Authorization: 'Bearer e2e-gateway-key',
    'X-SG-User-ID': toSGScopeToken(String(file.user), 'user'),
    'X-SG-Tenant-ID': toSGScopeToken(file.tenantId, 'tenant'),
    'X-SG-Conversation-ID': file.metadata!.sgGateway!.conversationId,
  };
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(200);
  expect((await page.request.get(download, { headers })).status()).toBe(200);
  expect(
    (
      await page.request.post(`/__e2e/expire-file/${file.file_id}?defer=true`, { headers })
    ).status(),
  ).toBe(200);
  expect([403, 404]).toContain((await page.request.get(download, { headers })).status());
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(false);
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(200);
  const expired = await page.request.post(`/__e2e/expire-file/${file.file_id}`, { headers });
  expect(expired.status()).toBe(200);
  expect(await expired.json()).toMatchObject({
    scanned: 1,
    deleted: 1,
    failed: 0,
    state: 'complete',
  });
  expect(
    (await fetchJson<TFile[]>(page, '/api/files', token)).some(
      (entry) => entry.file_id === file.file_id,
    ),
  ).toBe(false);
  expect([403, 404]).toContain((await page.request.get(download, { headers })).status());
  expect((await page.request.get(gatewayDownload, { headers: gatewayHeaders })).status()).toBe(404);
  expect(
    (await (await page.request.get('http://127.0.0.1:4010/observations')).json()).generation,
  ).toHaveLength(1);
});
