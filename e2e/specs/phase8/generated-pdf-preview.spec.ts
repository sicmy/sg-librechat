import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const fixturePath = path.resolve(
  process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
  'docs/samples/user-validation/phase3/01-native.pdf',
);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('previews and downloads a persisted Code Interpreter PDF after reload', async ({ page }) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const conversationId = `phase8-generated-pdf-${suffix}`;
  const messageId = `${conversationId}-message`;
  const fileId = `${conversationId}-file`;
  const toolCallId = `${conversationId}-tool`;
  const filename = 'generated-report.pdf';
  const now = new Date(0).toISOString();
  const pdf = fs.readFileSync(fixturePath);
  const attachment = {
    file_id: fileId,
    filename,
    filepath: `/uploads/e2e/${fileId}__${filename}`,
    type: 'application/pdf',
    source: 'local',
    context: 'execute_code',
    bytes: pdf.length,
    messageId,
    conversationId,
    toolCallId,
  };
  const message = {
    messageId,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'SG AI Gateway',
    endpoint: 'SG AI Gateway',
    model: 'default',
    text: '',
    content: [
      {
        type: 'tool_call',
        tool_call: {
          id: toolCallId,
          name: 'execute_code',
          args: '{"lang":"py","code":"# generate PDF"}',
          output: 'Generated files:',
          progress: 1,
        },
      },
    ],
    attachments: [attachment],
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Generated PDF preview',
    endpoint: 'SG AI Gateway',
    endpointType: 'custom',
    model: 'default',
    createdAt: now,
    updatedAt: now,
  };

  const conversationPattern = escapeRegExp(conversationId);
  await page.route(new RegExp(`/api/convos/${conversationPattern}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${conversationPattern}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  await page.route(
    new RegExp(`/api/files/download/[^/]+/${escapeRegExp(fileId)}(?:\\?.*)?$`),
    (route: Route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }),
  );

  const openPreview = async () => {
    await page.getByRole('button', { name: filename, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(filename, { exact: true })).toBeVisible();
    await expect(dialog.getByTitle(`Preview: ${filename}`)).toHaveAttribute('src', /^blob:/);
    return dialog;
  };

  await page.goto(`/c/${conversationId}`);
  let dialog = await openPreview();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: `Download ${filename}` }).click();
  expect((await downloading).suggestedFilename()).toBe(filename);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.reload();
  dialog = await openPreview();
  await expect(dialog.getByTitle(`Preview: ${filename}`)).toBeVisible();
});
