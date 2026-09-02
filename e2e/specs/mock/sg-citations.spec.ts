import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const PAGE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=',
  'base64',
);

const unique = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('SG typed citations', () => {
  test('opens the scoped PDF page panel and downloads the original after reload', async ({
    page,
  }) => {
    const conversationId = unique('sg-citation');
    const fileId = unique('file');
    const filename = 'policy.pdf';
    const quote = 'Approved equipment must be inspected monthly.';
    const now = new Date(0).toISOString();
    let pageRequests = 0;

    const conversation = {
      conversationId,
      title: 'SG Citation Review',
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
      createdAt: now,
      updatedAt: now,
    };
    const message = {
      messageId: `${conversationId}-assistant`,
      conversationId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: false,
      sender: 'Assistant',
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      text: 'Monthly inspection is required.',
      metadata: {
        sgCitations: {
          schema_version: 1,
          citations: [
            {
              schema_version: 1,
              citation_id: 'cite_policy_page_2',
              file_id: fileId,
              display_name: filename,
              mime_type: 'application/pdf',
              locator: {
                kind: 'page',
                page_number: 2,
                bbox: {
                  coordinate_space: 'normalized',
                  left: 0.1,
                  top: 0.2,
                  right: 0.8,
                  bottom: 0.4,
                },
              },
              quote,
              relevance_score: 0.94,
              preview_path: `/internal/files/${fileId}/pages/2`,
              download_path: `/internal/files/${fileId}/download`,
            },
          ],
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    const conversationPattern = new RegExp(`/api/convos/${escapeRe(conversationId)}(?:\\?.*)?$`);
    const messagesPattern = new RegExp(`/api/messages/${escapeRe(conversationId)}(?:\\?.*)?$`);
    await page.route(conversationPattern, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversation),
      }),
    );
    await page.route(messagesPattern, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([message]),
      }),
    );
    await page.route(`**/api/files/sg-citation/${fileId}/pages/2`, (route: Route) => {
      pageRequests += 1;
      return route.fulfill({ status: 200, contentType: 'image/png', body: PAGE_PNG });
    });
    await page.route(`**/api/files/sg-citation/${fileId}/download`, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
        body: Buffer.from('%PDF-1.4\n%%EOF\n'),
      }),
    );

    await page.goto(`/c/${conversationId}`, { timeout: 30_000 });

    const badge = page.getByRole('button', { name: `Open source 1: ${filename}` });
    await expect(badge).toBeVisible();
    expect(pageRequests).toBe(0);

    await badge.click();
    await expect(page.getByRole('complementary', { name: 'Sources' })).toBeVisible();
    await expect(page.getByAltText(`Page 2 of ${filename}`)).toBeVisible();
    await expect(page.getByTestId('sg-citation-highlight')).toBeVisible();
    await expect(page.getByText(quote).first()).toBeVisible();
    expect(pageRequests).toBe(1);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);

    await page.reload({ timeout: 30_000 });
    await expect(badge).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Sources' })).toHaveCount(0);
    await badge.click();
    await expect(page.getByAltText(`Page 2 of ${filename}`)).toBeVisible();
    expect(pageRequests).toBe(2);
  });
});
