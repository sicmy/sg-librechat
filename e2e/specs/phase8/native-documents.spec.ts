import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import {
  escapeRegExp,
  fetchJson,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../mock/helpers';

interface NativeDocumentFixture {
  filename: string;
  mimeType: string;
  marker: string;
}

const fixtureRoot = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'docs/samples/user-validation/phase3',
);

const fixtures: NativeDocumentFixture[] = [
  {
    filename: '04-document.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    marker: '220V',
  },
  {
    filename: '05-document.odt',
    mimeType: 'application/vnd.oasis.opendocument.text',
    marker: '220V',
  },
  {
    filename: '06-presentation.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    marker: '30일마다',
  },
  {
    filename: '07-workbook.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    marker: '냉각펌프',
  },
  { filename: '08-text.txt', mimeType: 'text/plain', marker: 'A동 2층' },
  { filename: '09-markdown.md', mimeType: 'text/markdown', marker: '외관 점검' },
  { filename: '10-code.py', mimeType: 'text/x-python', marker: 'STOP_TEMP_C' },
  { filename: '11-table.csv', mimeType: 'text/csv', marker: 'PUMP-A' },
  { filename: '12-data.json', mimeType: 'application/json', marker: '중앙 창고' },
  { filename: '13-data.xml', mimeType: 'application/xml', marker: '중앙 창고' },
];

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceBadge(page: Page, filename: string) {
  return page.getByRole('button', {
    name: new RegExp(`Open source \\d+: ${escapeRegExp(filename)}($|\\s)`),
  });
}

async function uploadDocument(page: Page, fixture: NativeDocumentFixture): Promise<Buffer> {
  const source = fs.readFileSync(path.join(fixtureRoot, fixture.filename));
  await page.locator('input[type="file"]').last().setInputFiles({
    name: fixture.filename,
    mimeType: fixture.mimeType,
    buffer: source,
  });
  await expect(
    page
      .getByRole('button', { name: fixture.filename, exact: true })
      .filter({ hasText: 'Finished analyzing' }),
  ).toBeVisible({ timeout: 30_000 });
  return source;
}

async function latestAssistant(page: Page): Promise<TMessage> {
  const conversationId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  if (!conversationId || conversationId === 'new') {
    throw new Error(`Expected a persisted conversation URL, received ${page.url()}`);
  }
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    await getAccessToken(page),
  );
  const assistant = messages.findLast(({ isCreatedByUser }) => isCreatedByUser === false);
  if (!assistant) {
    throw new Error('Expected a persisted assistant response');
  }
  return assistant;
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

for (const fixture of fixtures) {
  test(`connects ${fixture.filename} from browser upload through citation and download`, async ({
    page,
  }) => {
    await page.goto('/c/new');
    const source = await uploadDocument(page, fixture);

    await sendMessageAndWaitForCompletion(
      page,
      'Summarize the attached document and show the supporting source.',
    );
    const persisted = await latestAssistant(page);
    const citations = persisted.metadata?.sgCitations?.citations ?? [];
    const matchingCitation = citations.find(
      ({ display_name, quote }) =>
        display_name === fixture.filename && quote.includes(fixture.marker),
    );
    expect(matchingCitation, JSON.stringify(citations)).toBeTruthy();

    const badge = sourceBadge(page, fixture.filename);
    await expect(badge.first()).toBeVisible();
    await badge.first().click();
    const sources = page.getByRole('complementary', { name: 'Sources' });
    await expect(sources).toBeVisible();
    await expect(sources.getByText(fixture.marker, { exact: false }).first()).toBeVisible();

    const downloading = page.waitForEvent('download');
    await sources.getByRole('button', { name: 'Download' }).click();
    const download = await downloading;
    const downloadedPath = await download.path();
    if (!downloadedPath) {
      throw new Error(`${fixture.filename} download did not produce a file`);
    }
    expect(download.suggestedFilename()).toBe(fixture.filename);
    expect(sha256(fs.readFileSync(downloadedPath))).toBe(sha256(source));

    await page.reload();
    await expect(badge.first()).toBeVisible();
  });
}

test('keeps an earlier citation when a different document type is attached later', async ({
  page,
}) => {
  const textFixture = fixtures.find(({ filename }) => filename === '08-text.txt');
  const csvFixture = fixtures.find(({ filename }) => filename === '11-table.csv');
  if (!textFixture || !csvFixture) {
    throw new Error('Follow-up attachment fixtures are missing');
  }

  await page.goto('/c/new');
  await uploadDocument(page, textFixture);
  await sendMessageAndWaitForCompletion(
    page,
    'Summarize the attached inspection note and show the source.',
  );
  const conversationId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  await expect(sourceBadge(page, textFixture.filename).first()).toBeVisible();

  await uploadDocument(page, csvFixture);
  await sendMessageAndWaitForCompletion(
    page,
    'Summarize the newly attached inventory table and show the source.',
  );
  expect(new URL(page.url()).pathname.split('/').filter(Boolean).at(-1)).toBe(conversationId);
  const persisted = await latestAssistant(page);
  expect(
    persisted.metadata?.sgCitations?.citations.some(
      ({ display_name, quote }) =>
        display_name === csvFixture.filename && quote.includes(csvFixture.marker),
    ),
  ).toBe(true);
  await expect(sourceBadge(page, csvFixture.filename).first()).toBeVisible();

  await page.reload();
  await expect(sourceBadge(page, textFixture.filename).first()).toBeVisible();
  await expect(sourceBadge(page, csvFixture.filename).first()).toBeVisible();
});

test('continues with a valid document after unsafe XML is rejected', async ({ page }) => {
  const recoveryFixture = fixtures.find(({ filename }) => filename === '08-text.txt');
  if (!recoveryFixture) {
    throw new Error('Recovery fixture is missing');
  }

  await page.goto('/c/new');
  const invalidName = 'unsafe-document.xml';
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: invalidName,
      mimeType: 'application/xml',
      buffer: Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE inventory [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><inventory>&xxe;</inventory>',
      ),
    });
  const rejected = page.getByRole('button', { name: invalidName, exact: true });
  await expect(rejected).toContainText('Cannot analyze this file', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Remove file' }).click();
  await expect(rejected).toHaveCount(0);

  await uploadDocument(page, recoveryFixture);
  await sendMessageAndWaitForCompletion(
    page,
    'Summarize the valid inspection note and show the source.',
  );
  const persisted = await latestAssistant(page);
  expect(
    persisted.metadata?.sgCitations?.citations.some(
      ({ display_name, quote }) =>
        display_name === recoveryFixture.filename && quote.includes(recoveryFixture.marker),
    ),
  ).toBe(true);
  await expect(sourceBadge(page, recoveryFixture.filename).first()).toBeVisible();
  await expect(sourceBadge(page, invalidName)).toHaveCount(0);
});
