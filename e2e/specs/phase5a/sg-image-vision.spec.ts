import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { messagesView, sendMessageAndWaitForCompletion } from '../mock/helpers';

type VisionObservation = {
  fixture_id: string;
  pixels_match: boolean;
  evidence_count: number;
};

type ChatObservation = {
  has_vision_tool: boolean;
  has_vision_result: boolean;
};

type StubObservations = {
  chat: ChatObservation[];
  vision: VisionObservation[];
};

const STUB_URL = 'http://127.0.0.1:4010';
const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('SG_GATEWAY_E2E_ROOT is required');
}
const fixtureRoot = path.resolve(gatewayRoot, 'services/sg-ai-gateway/tests/fixtures/vision');
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(fixtureRoot, 'safety-panel.realistic.expected.json'), 'utf8'),
) as {
  fixture_id: string;
  image: string;
  sha256: string;
  questions: Array<{ prompt: string; expected_answer: string }>;
  evidence: Array<{
    id: string;
    bbox: { left: number; top: number; right: number; bottom: number };
  }>;
};
const fixturePath = path.resolve(fixtureRoot, manifest.image);

async function resetObservations(page: Page): Promise<void> {
  const response = await page.request.delete(`${STUB_URL}/observations`);
  expect(response.ok()).toBeTruthy();
}

async function readObservations(page: Page): Promise<StubObservations> {
  const response = await page.request.get(`${STUB_URL}/observations`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as StubObservations;
}

function latestAnswer(page: Page, answer: string) {
  return messagesView(page).locator('.message-render').filter({ hasText: answer }).last();
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await resetObservations(page);
  await page.goto('/c/new');
});

test('uploads one image, lets Default select Vision, and persists grounded bbox citations', async ({
  page,
}) => {
  const filename = path.basename(fixturePath);
  await expect(page.getByRole('button', { name: 'Attach Files' })).toBeVisible();
  await page.locator('input[type="file"]').last().setInputFiles(fixturePath);
  await expect(
    page
      .getByRole('button', { name: filename, exact: true })
      .filter({ hasText: 'Finished analyzing' }),
  ).toBeVisible({ timeout: 30_000 });

  const question = manifest.questions[0];
  await sendMessageAndWaitForCompletion(page, question.prompt);
  const response = latestAnswer(page, question.expected_answer);
  await expect(response.getByText(question.expected_answer)).toBeVisible();

  const badge = response.getByRole('button', { name: `Open source 1: ${filename}` });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByRole('complementary', { name: 'Sources' })).toBeVisible();
  await expect(page.getByAltText(`Image preview of ${filename}`)).toBeVisible();
  const highlight = page.getByTestId('sg-citation-highlight');
  await expect(highlight).toBeVisible();
  const bbox = manifest.evidence.find(({ id }) => id === 'pressure_gauge_danger')?.bbox;
  expect(bbox).toBeDefined();
  expect(await highlight.evaluate((element) => (element as HTMLElement).style.left)).toBe(
    `${bbox!.left * 100}%`,
  );
  expect(await highlight.evaluate((element) => (element as HTMLElement).style.top)).toBe(
    `${bbox!.top * 100}%`,
  );

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(downloadPath as string))
    .digest('hex');
  expect(digest).toBe(manifest.sha256);

  const observations = await readObservations(page);
  expect(observations.vision).toEqual([
    {
      fixture_id: manifest.fixture_id,
      pixels_match: true,
      evidence_count: 2,
    },
  ]);
  expect(observations.chat.filter(({ has_vision_tool }) => has_vision_tool)).toHaveLength(1);
  expect(observations.chat.filter(({ has_vision_result }) => has_vision_result)).toHaveLength(1);

  await page.reload();
  await expect(badge).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sources' })).toHaveCount(0);

  await sendMessageAndWaitForCompletion(page, '첨부 이미지의 파일 정보만 알려 줘.');
  await expect(
    latestAnswer(page, '첨부된 이미지의 파일 정보 질문에는 Vision이 필요하지 않습니다.'),
  ).toBeVisible();
  const afterMetadataQuestion = await readObservations(page);
  expect(afterMetadataQuestion.vision).toHaveLength(1);
  expect(afterMetadataQuestion.chat.filter(({ has_vision_tool }) => has_vision_tool)).toHaveLength(
    2,
  );
});
