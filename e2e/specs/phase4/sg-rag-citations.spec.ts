import fs from 'fs';
import { expect, test } from '@playwright/test';
import type { FilePayload, Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  fetchJson,
  getAccessToken,
  messagesView,
  sendMessageAndWaitForCompletion,
} from '../mock/helpers';

type MarkerObservation = {
  direct_alpha: boolean;
  rag_needle: boolean;
  multi_alpha: boolean;
  multi_beta: boolean;
};

type ChatObservation = MarkerObservation & {
  has_untrusted_evidence: boolean;
  has_citation_id: boolean;
};

type EmbeddingObservation = MarkerObservation & {
  is_batch: boolean;
  input_count: number;
};

type RerankObservation = MarkerObservation & {
  text_count: number;
  has_relevant_text: boolean;
};

type StubObservations = {
  chat: ChatObservation[];
  embeddings: EmbeddingObservation[];
  rerank: RerankObservation[];
};

const STUB_URL = 'http://127.0.0.1:4010';

function textFile(name: string, content: string): FilePayload {
  return {
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(content, 'utf8'),
  };
}

function largeRagFile(): FilePayload {
  const lines = Array.from(
    { length: 3_000 },
    (_, index) => `distractor-${index.toString().padStart(4, '0')} ${'background '.repeat(8)}`,
  );
  lines[1_500] = 'RAG_NEEDLE is the deterministic retrieval target.';
  return textFile('rag-large.txt', lines.join('\n'));
}

async function resetObservations(page: Page): Promise<void> {
  const response = await page.request.delete(`${STUB_URL}/observations`);
  expect(response.ok()).toBeTruthy();
}

async function readObservations(page: Page): Promise<StubObservations> {
  const response = await page.request.get(`${STUB_URL}/observations`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as StubObservations;
}

async function uploadFiles(page: Page, files: FilePayload[]): Promise<void> {
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page.locator('input[type="file"]').last().setInputFiles(files);

  await Promise.all(
    files.map(({ name }) =>
      expect(
        page.getByRole('button', { name, exact: true }).filter({ hasText: 'Finished analyzing' }),
      ).toBeVisible({ timeout: 30_000 }),
    ),
  );
}

function latestAnswer(page: Page, answer: string) {
  return messagesView(page).locator('.message-render').filter({ hasText: answer }).last();
}

async function latestPersistedAssistant(page: Page): Promise<TMessage> {
  const conversationId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  if (!conversationId || conversationId === 'new') {
    throw new Error(`Expected a persisted conversation URL, received ${page.url()}`);
  }
  const token = await getAccessToken(page);
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  );
  const assistant = messages.findLast(({ isCreatedByUser }) => isCreatedByUser === false);
  if (!assistant) {
    throw new Error('Expected a persisted assistant response');
  }
  return assistant;
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await resetObservations(page);
  await page.goto('/c/new');
});

test('uses bounded direct context and persists citation UI with authorized download', async ({
  page,
}) => {
  const filename = 'direct-small.txt';
  const content = 'DIRECT_ALPHA is the approved direct-context value.';
  await uploadFiles(page, [textFile(filename, content)]);

  const answer = 'Direct answer: DIRECT_ALPHA.';
  await sendMessageAndWaitForCompletion(page, 'Return DIRECT_ALPHA from the attached file.');
  const response = latestAnswer(page, answer);
  await expect(response.getByText(answer)).toBeVisible();
  const persisted = await latestPersistedAssistant(page);
  expect(persisted.metadata?.sgCitations?.citations).toHaveLength(1);

  const badge = page.getByRole('button', {
    name: `Open source 1: ${filename}`,
  });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByRole('complementary', { name: 'Sources' })).toBeVisible();
  await expect(page.getByText(content).first()).toBeVisible();
  await expect(
    page.getByText('A visual preview is not available for this source location.'),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(fs.readFileSync(downloadPath as string, 'utf8')).toBe(content);

  const observations = await readObservations(page);
  expect(observations.chat).toHaveLength(1);
  expect(observations.chat[0]).toMatchObject({
    direct_alpha: true,
    has_untrusted_evidence: true,
    has_citation_id: false,
  });
  expect(observations.embeddings.filter(({ is_batch }) => is_batch)).toHaveLength(1);
  expect(observations.embeddings.filter(({ is_batch }) => !is_batch)).toHaveLength(0);
  expect(observations.rerank).toHaveLength(0);

  await page.reload();
  await expect(badge).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sources' })).toHaveCount(0);
});

test('uses automatic RAG and reuses the index for a follow-up question', async ({ page }) => {
  await uploadFiles(page, [largeRagFile()]);

  const answer = 'RAG answer: RAG_NEEDLE.';
  await sendMessageAndWaitForCompletion(page, 'Find RAG_NEEDLE in the attached file.');
  const firstResponse = latestAnswer(page, answer);
  await expect(firstResponse.getByText(answer)).toBeVisible();
  await expect(
    firstResponse.getByRole('button', { name: /Open source 1: rag-large\.txt/ }),
  ).toBeVisible();

  const first = await readObservations(page);
  const indexedBatches = first.embeddings.filter(({ is_batch }) => is_batch).length;
  expect(indexedBatches).toBeGreaterThan(0);
  expect(first.embeddings.filter(({ is_batch }) => !is_batch)).toHaveLength(1);
  expect(first.rerank).toHaveLength(1);
  expect(first.rerank[0]).toMatchObject({ rag_needle: true, has_relevant_text: true });
  expect(first.chat[0]).toMatchObject({
    rag_needle: true,
    has_untrusted_evidence: true,
    has_citation_id: true,
  });

  await sendMessageAndWaitForCompletion(
    page,
    'Follow up using the same attachment: repeat RAG_NEEDLE.',
  );
  const secondResponse = latestAnswer(page, answer);
  await expect(secondResponse.getByText(answer)).toBeVisible();
  await expect(
    secondResponse.getByRole('button', { name: /Open source 1: rag-large\.txt/ }),
  ).toBeVisible();

  const second = await readObservations(page);
  expect(second.embeddings.filter(({ is_batch }) => is_batch)).toHaveLength(indexedBatches);
  expect(second.embeddings.filter(({ is_batch }) => !is_batch)).toHaveLength(2);
  expect(second.rerank).toHaveLength(2);
  expect(second.chat).toHaveLength(2);
  expect(second.chat[1].has_citation_id).toBe(true);
});

test('keeps citations scoped to both files in one conversation', async ({ page }) => {
  const alpha = textFile('multi-alpha.txt', 'MULTI_ALPHA belongs to the alpha document.');
  const beta = textFile('multi-beta.txt', 'MULTI_BETA belongs to the beta document.');
  await uploadFiles(page, [alpha, beta]);

  const answer = 'Multiple-file answer: MULTI_ALPHA and MULTI_BETA.';
  await sendMessageAndWaitForCompletion(
    page,
    'Return both MULTI_ALPHA and MULTI_BETA from the attached files.',
  );
  const response = latestAnswer(page, answer);
  await expect(response.getByText(answer)).toBeVisible();
  await expect(
    response.getByRole('button', { name: /Open source \d+: multi-alpha\.txt/ }),
  ).toBeVisible();
  await expect(
    response.getByRole('button', { name: /Open source \d+: multi-beta\.txt/ }),
  ).toBeVisible();

  const observations = await readObservations(page);
  expect(observations.chat).toHaveLength(1);
  expect(observations.chat[0]).toMatchObject({
    multi_alpha: true,
    multi_beta: true,
    has_untrusted_evidence: true,
    has_citation_id: false,
  });
  expect(observations.embeddings.filter(({ is_batch }) => is_batch)).toHaveLength(2);
  expect(observations.embeddings.filter(({ is_batch }) => !is_batch)).toHaveLength(0);
  expect(observations.rerank).toHaveLength(0);
});
