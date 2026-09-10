import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import {
  getAccessToken,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../mock/helpers';

const SANDPACK_ORIGIN = 'http://127.0.0.1:5081';
const APPROVED_PACKAGE_HOSTS = new Set([
  'prod-packager-packages.codesandbox.io',
  'aiwi8rnkp5.execute-api.eu-west-1.amazonaws.com',
  'data.jsdelivr.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
]);
const BLOCKED_NONESSENTIAL_HOSTS = new Set(['col.csbops.io']);

async function openArtifact(page: Parameters<typeof messagesView>[0], title: string) {
  const button = messagesView(page).getByRole('button', {
    name: `${title} Click to open`,
    exact: true,
  });
  await expect(button).toBeVisible();
  await button.click();
  const region = page.getByRole('region', { name: title });
  await expect(region).toBeVisible();
  return region;
}

async function renderedFrame(
  page: Page,
  text: string,
  timeout: number,
  diagnostics: string[],
): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if ((await frame.getByText(text, { exact: true }).count()) > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  const frames = await Promise.all(
    page.frames().map(async (frame) => ({
      url: frame.url().replace(/\?.*$/, ''),
      text: (
        await frame
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 300),
    })),
  );
  throw new Error(`No rendered frame contains ${text}: ${JSON.stringify({ frames, diagnostics })}`);
}

test('renders interactive HTML and React through the self-hosted Sandpack runtime', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const unexpectedExternalRequests: string[] = [];
  const approvedPackageHosts = new Set<string>();
  const diagnostics: string[] = [];
  let watchingArtifacts = false;
  page.on('console', (message) => {
    if (watchingArtifacts && ['error', 'warning'].includes(message.type())) {
      diagnostics.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (watchingArtifacts) {
      diagnostics.push(
        `requestfailed: ${new URL(request.url()).origin} ${request.failure()?.errorText ?? ''}`,
      );
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (watchingArtifacts && BLOCKED_NONESSENTIAL_HOSTS.has(url.hostname)) {
      diagnostics.push(`blocked nonessential request: ${url.origin}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (
      watchingArtifacts &&
      !['127.0.0.1', 'localhost'].includes(url.hostname) &&
      !APPROVED_PACKAGE_HOSTS.has(url.hostname)
    ) {
      unexpectedExternalRequests.push(url.origin);
      diagnostics.push(`blocked external request: ${url.origin}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (watchingArtifacts && APPROVED_PACKAGE_HOSTS.has(url.hostname)) {
      approvedPackageHosts.add(url.hostname);
    }
    await route.continue();
  });

  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  const config = await (
    await page.request.get('/api/config', {
      headers: { Authorization: `Bearer ${await getAccessToken(page)}` },
    })
  ).json();
  expect(config.bundlerURL).toBe(SANDPACK_ORIGIN);
  expect(config.staticBundlerURL).toBeUndefined();
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  watchingArtifacts = true;

  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY');
  const htmlRegion = await openArtifact(page, 'E2E HTML Artifact');
  await expect(htmlRegion.locator('iframe')).toHaveCount(1);
  const htmlFrame = await renderedFrame(page, 'HTML sandbox fixture', 30_000, diagnostics);
  await htmlFrame.getByRole('button', { name: 'HTML count: 0' }).click();
  await expect(htmlFrame.getByRole('button', { name: 'HTML count: 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await sendMessageAndWaitForCompletion(page, 'E2E_REACT_ARTIFACT_REPLY');
  const reactRegion = await openArtifact(page, 'E2E React Artifact');
  await expect(reactRegion.locator('iframe')).toHaveCount(1);
  const reactFrame = await renderedFrame(page, 'React sandbox fixture', 60_000, diagnostics);
  await reactFrame.getByRole('button', { name: 'React count: 0' }).click();
  await expect(reactFrame.getByRole('button', { name: 'React count: 1' })).toBeVisible();

  expect(unexpectedExternalRequests).toEqual([]);
  expect(approvedPackageHosts.size).toBeGreaterThan(0);
});
