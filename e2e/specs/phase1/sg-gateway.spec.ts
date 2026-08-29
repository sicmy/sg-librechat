import { expect, request as playwrightRequest, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { getSecondaryE2EUser } from '../../setup/users.mock';
import {
  isAgentsStream,
  messagesView,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from '../mock/helpers';

type CapturedRequest = {
  model: string;
  stream: boolean;
  enable_thinking: boolean;
  thinking_budget: number;
};

type StubState = {
  requests: CapturedRequest[];
};

const STUB_URL = 'http://127.0.0.1:4010';
const GATEWAY_URL = 'http://127.0.0.1:4000';
const DETERMINISTIC_ANSWER = 'Phase 1 deterministic answer.';
const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

const expectedRequest = (thinking_budget: number, stream = true): CapturedRequest => ({
  model: 'qwen3.7-plus',
  stream,
  enable_thinking: true,
  thinking_budget,
});

async function readStubRequests(request: APIRequestContext): Promise<CapturedRequest[]> {
  const response = await request.get(`${STUB_URL}/requests`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as StubState).requests;
}

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.delete(`${STUB_URL}/requests`);
  expect(response.ok()).toBeTruthy();
}

async function chooseDepth(page: Page, current: string, next: string): Promise<void> {
  await page.getByRole('combobox', { name: `Response depth: ${current}` }).click();
  await page.getByRole('option', { name: next, exact: true }).click();
  await expect(page.getByRole('combobox', { name: `Response depth: ${next}` })).toBeVisible();
}

async function registerRegularUser(browser: Browser, baseURL: string): Promise<Page> {
  const user = getSecondaryE2EUser();
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  let storageState: Awaited<ReturnType<APIRequestContext['storageState']>>;
  try {
    const registration = await api.post('/api/auth/register', {
      data: {
        email: user.email,
        name: user.name,
        password: user.password,
        confirm_password: user.password,
      },
    });
    expect(registration.ok()).toBeTruthy();
    const login = await api.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    expect(login.ok()).toBeTruthy();
    const loginPayload = (await login.json()) as { user?: { role?: string } };
    expect(loginPayload.user?.role).toBe('USER');
    storageState = await api.storageState();
  } finally {
    await api.dispose();
  }

  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto(new URL('/c/new', baseURL).toString());
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await resetStub(request);
});

test('keeps parent secrets out of child processes and routes Gateway loopback directly', async ({
  request,
}) => {
  expect(process.env.PHASE1_SENTINEL_SECRET).toBeUndefined();
  expect(process.env.HTTP_PROXY).toBe('');
  expect(process.env.HTTPS_PROXY).toBe('');
  expect(process.env.ALL_PROXY).toBe('');
  expect(process.env.http_proxy).toBe('');
  expect(process.env.https_proxy).toBe('');
  expect(process.env.all_proxy).toBe('');
  expect(process.env.NO_PROXY).toBe(LOOPBACK_NO_PROXY);
  expect(process.env.no_proxy).toBe(LOOPBACK_NO_PROXY);

  const response = await request.post(`${GATEWAY_URL}/v1/chat/completions`, {
    headers: { Authorization: 'Bearer e2e-gateway-key' },
    data: {
      model: 'default',
      messages: [{ role: 'user', content: 'Hermetic loopback probe.' }],
      stream: false,
      effort: 'low',
    },
  });
  expect(response.ok()).toBeTruthy();
  const completion = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  expect(completion.choices?.[0]?.message?.content).toBe(DETERMINISTIC_ANSWER);
  await expect.poll(() => readStubRequests(request)).toEqual([expectedRequest(4_096, false)]);
});

test('routes every response depth through Gateway while preserving the conversation choice', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto('/c/new');

  await expect(page.getByRole('button', { name: 'Select a model' })).toHaveCount(0);
  await expect(page.getByText('SG AI Gateway', { exact: true })).toHaveCount(0);
  await expect(page.getByText('default', { exact: true })).toHaveCount(0);

  const depth = page.getByRole('combobox', { name: 'Response depth: Balanced' });
  const attachmentControls = page
    .getByRole('button', { name: 'Attach File Options' })
    .locator('..');
  await expect(depth).toHaveCount(1);
  await expect(depth).toHaveText('');
  await expect(
    attachmentControls.getByRole('combobox', { name: 'Response depth: Balanced' }),
  ).toHaveCount(1);

  await depth.click();
  const depthOptions = page.getByRole('option').filter({ hasText: /^(Quick|Balanced|Deep)$/ });
  await expect(depthOptions).toHaveCount(3);
  const messageInput = page.getByRole('textbox', { name: 'Message input' });
  const inputBox = await messageInput.boundingBox();
  if (!inputBox) {
    throw new Error('Message input must have a visible bounding box');
  }
  await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
  await expect(depthOptions).toHaveCount(0);

  await chooseDepth(page, 'Balanced', 'Balanced');
  await sendMessageAndWaitForCompletion(page, 'Verify the balanced path.');
  await expect(messagesView(page).getByText(DETERMINISTIC_ANSWER).last()).toBeVisible();
  await expect(messagesView(page).getByText('Response depth: Balanced')).toBeVisible();
  await expect.poll(() => readStubRequests(request)).toEqual([expectedRequest(16_384)]);

  await chooseDepth(page, 'Balanced', 'Quick');
  await sendMessageAndWaitForCompletion(page, 'Verify the quick path.');
  await expect
    .poll(() => readStubRequests(request))
    .toEqual([expectedRequest(16_384), expectedRequest(4_096)]);

  const conversationURL = page.url();
  await page.goto('/c/new');
  await page.goto(conversationURL);
  await expect(page.getByRole('combobox', { name: 'Response depth: Quick' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Response depth: Quick' })).toBeVisible();

  const deterministicAnswers = messagesView(page).getByText(DETERMINISTIC_ANSWER);
  await expect(deterministicAnswers).toHaveCount(2);
  await sendMessage(page, 'Keep the next selection while this response streams.');
  await expect.poll(async () => (await readStubRequests(request)).length).toBe(3);
  await chooseDepth(page, 'Quick', 'Deep');
  await expect(deterministicAnswers).toHaveCount(3);
  await expect(page.getByRole('combobox', { name: 'Response depth: Deep' })).toBeVisible();

  await sendMessageAndWaitForCompletion(page, 'Verify the deep path.');
  await expect(deterministicAnswers).toHaveCount(4);
  await expect(page.getByRole('combobox', { name: 'Response depth: Deep' })).toBeVisible();
  await expect
    .poll(() => readStubRequests(request))
    .toEqual([
      expectedRequest(16_384),
      expectedRequest(4_096),
      expectedRequest(4_096),
      expectedRequest(65_536),
    ]);

  const deepAssistant = messagesView(page)
    .locator('.message-render')
    .filter({ hasText: DETERMINISTIC_ANSWER })
    .last();
  await deepAssistant.hover();
  const regenerate = deepAssistant.getByRole('button', { name: 'Regenerate', exact: true }).last();
  await expect(regenerate).toBeVisible();
  await chooseDepth(page, 'Deep', 'Quick');
  const [regenerateResponse] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30_000 }),
    regenerate.click(),
  ]);
  expect(regenerateResponse.ok()).toBeTruthy();
  await expect
    .poll(() => readStubRequests(request))
    .toEqual([
      expectedRequest(16_384),
      expectedRequest(4_096),
      expectedRequest(4_096),
      expectedRequest(65_536),
      expectedRequest(65_536),
    ]);
  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Response depth: Quick' })).toBeVisible();
});

test('hides submitted-turn depth badges from a regular user', async ({
  browser,
  baseURL,
  request,
}) => {
  test.setTimeout(60_000);
  if (typeof baseURL !== 'string') {
    throw new Error('Phase 1 E2E requires a baseURL');
  }

  const page = await registerRegularUser(browser, baseURL);
  try {
    const regularPrompt = 'Verify the regular user view.';
    await sendMessageAndWaitForCompletion(page, regularPrompt);
    await expect(messagesView(page).getByText(DETERMINISTIC_ANSWER)).toBeVisible();
    const submittedMessage = messagesView(page)
      .locator('.message-render')
      .filter({ hasText: regularPrompt });
    await expect(
      submittedMessage.getByText('Response depth: Balanced', { exact: true }),
    ).toHaveCount(0);
    await expect(submittedMessage.getByLabel('Response depth: Balanced')).toHaveCount(0);
    await expect(submittedMessage.locator('[data-effort]')).toHaveCount(0);
    await expect.poll(() => readStubRequests(request)).toEqual([expectedRequest(16_384)]);
  } finally {
    await page.context().close();
  }
});
