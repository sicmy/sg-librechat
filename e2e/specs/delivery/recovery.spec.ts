import { expect, test } from '@playwright/test';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import type { TMessage } from 'librechat-data-provider';
import {
  sendMessage,
  sendMessageAndWaitForCompletion,
  fetchJson,
  getAccessToken,
} from '../mock/helpers';

const audio = JSON.parse(
  fs.readFileSync(
    path.resolve(
      process.env.SG_GATEWAY_E2E_ROOT ?? '../sg-ai-platform',
      'services/sg-ai-gateway/tests/fixtures/audio/maintenance.expected.json',
    ),
    'utf8',
  ),
) as { transcript: string };

for (const kind of ['image', 'tts'] as const) {
  test(`${kind} delivery repairs the same response after a storage failure without regeneration`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.request.delete('http://127.0.0.1:4010/observations');
    await page.goto('/c/new');
    await sendMessage(
      page,
      kind === 'image'
        ? 'Create an image: An industrial safety panel.'
        : `Read aloud: ${audio.transcript}`,
    );
    const expectedStage = kind === 'image' ? 'registration' : 'message';
    await expect
      .poll(
        async () => {
          const observed = await (
            await page.request.get('http://127.0.0.1:4010/observations')
          ).json();
          return observed.delivery_failures.some(
            (failure: { stage: string }) => failure.stage === expectedStage,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(conversationId).not.toBe('new');
    const token = await getAccessToken(page);
    const before = await fetchJson<{ messages: TMessage[] }>(
      page,
      `/api/messages?conversationId=${conversationId}`,
      token,
    );
    const pending = before.messages.find((message) => message.metadata?.sgGeneration);
    expect(pending).toBeDefined();
    const beforeCalls = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
    expect(kind === 'image' ? beforeCalls.generation : beforeCalls.tts).toHaveLength(1);
    await page.reload();
    const repaired = await page.request.get(`/api/messages/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    expect(repaired.ok()).toBe(true);
    const after = (await repaired.json()) as TMessage[];
    const recovered = after.filter((message) => message.metadata?.sgArtifacts);
    expect(recovered, JSON.stringify(after)).toHaveLength(1);
    if (kind === 'image') {
      await expect(page.getByRole('img', { name: 'Generated image' })).toBeVisible();
    } else {
      await expect(page.getByLabel('Generated speech', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Generated speech', { exact: true })).toHaveCount(1);
    }
    expect(recovered[0].messageId).toBe(pending!.messageId);
    expect(recovered[0].metadata?.sgGeneration?.state).toBe('delivered');
    const artifact = recovered[0].metadata!.sgArtifacts!.artifacts[0];
    const download = await page.request.get(`/api/files/sg-citation/${artifact.file_id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(download.ok()).toBe(true);
    expect(
      crypto
        .createHash('sha256')
        .update(await download.body())
        .digest('hex'),
    ).toBe(artifact.sha256);
    await sendMessageAndWaitForCompletion(page, 'Hello');
    const afterCalls = await (await page.request.get('http://127.0.0.1:4010/observations')).json();
    expect(kind === 'image' ? afterCalls.generation : afterCalls.tts).toHaveLength(1);
  });
}
