import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TFile } from 'librechat-data-provider';
import {
  sendMessageAndWaitForCompletion,
  messagesView,
  fetchJson,
  getAccessToken,
} from '../mock/helpers';

test('restarts the Gateway process during analysis and restores the attachment after refresh', async ({
  page,
}) => {
  const file = await attach(page, 'restart.txt');
  await expect(file).toContainText('Analyzing');
  const token = await getAccessToken(page);
  const before = (await fetchJson<TFile[]>(page, '/api/files', token)).filter(
    (candidate) => candidate.filename === 'restart.txt',
  );
  expect(before).toHaveLength(1);
  const restarted = await page.request.post('http://127.0.0.1:4021/restart', {
    headers: { 'X-E2E-Control': 'isolated-recovery-test' },
  });
  expect(restarted.ok()).toBe(true);
  const processes = await restarted.json();
  expect(processes.previous_pid).not.toBe(processes.current_pid);
  await page.reload();
  await expect(file).toContainText('Finished analyzing');
  const after = (await fetchJson<TFile[]>(page, '/api/files', await getAccessToken(page))).filter(
    (candidate) => candidate.filename === 'restart.txt',
  );
  expect(after.map((candidate) => candidate.file_id)).toEqual([before[0].file_id]);
  await sendMessageAndWaitForCompletion(page, 'Return DIRECT_ALPHA from the recovered file.');
  await expect(messagesView(page).getByText('Direct answer: DIRECT_ALPHA.')).toHaveCount(1);
});

async function attach(page: Page, name: string) {
  await page.goto('/c/new');
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page.getByRole('link', { name: 'New chat', exact: true }).click();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('DIRECT_ALPHA is the recovery fixture fact.'),
    });
  return page.getByRole('button', { name, exact: true });
}

test('cancel preserves the file and explicit retry produces a grounded answer', async ({
  page,
}) => {
  const file = await attach(page, 'cancel-retry.txt');
  await expect(file).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel analysis', exact: true })).toBeVisible();
  await page.reload();
  await expect(file).toBeVisible();
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
  await expect(file).toContainText('Analysis cancelled');
  await expect(page.getByRole('button', { name: 'Cancel analysis', exact: true })).toHaveCount(0);
  const request = page.waitForResponse((response) => response.url().endsWith('/retry'));
  await page.getByRole('button', { name: 'Retry analysis', exact: true }).click();
  expect((await request).status()).toBe(200);
  await expect(file).toContainText('Finished analyzing');
  await sendMessageAndWaitForCompletion(page, 'Return DIRECT_ALPHA from the file.');
  await expect(messagesView(page).getByText('Direct answer: DIRECT_ALPHA.')).toBeVisible();
  await page.reload();
  await expect(messagesView(page).getByText('Direct answer: DIRECT_ALPHA.')).toBeVisible();
});

test('transient errors recover automatically and exhausted jobs allow an explicit retry', async ({
  page,
}) => {
  const automatic = await attach(page, 'retry-twice.txt');
  await expect(automatic).toContainText('Finished analyzing');
  await expect(page.getByRole('button', { name: 'Retry analysis', exact: true })).toHaveCount(0);
  const exhausted = await attach(page, 'exhausted.txt');
  await page.getByRole('button', { name: 'Retry analysis', exact: true }).click();
  await expect(exhausted).toContainText('Finished analyzing');
});

test('permanent failures have no retry action and disconnected status can be refreshed', async ({
  page,
}) => {
  const rejected = await attach(page, 'reject.txt');
  await expect(rejected).toContainText('Cannot analyze this file');
  await expect(page.getByRole('button', { name: 'Retry analysis', exact: true })).toHaveCount(0);
  await page.route('**/api/files/*/preview', (route) => route.abort('failed'));
  const pending = await attach(page, 'status-recovery.txt');
  await expect(pending).toContainText('Analysis status unavailable');
  await page.unroute('**/api/files/*/preview');
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(pending).toContainText('Finished analyzing');
});
