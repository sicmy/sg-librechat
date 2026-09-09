import { Constants } from 'librechat-data-provider';
import { createSGGenerationCheckpoint, resolveSGRequestMessageId } from './delivery';
import { recoverSGGenerationMessages } from './delivery';
import * as sg from './sg';
import type { SGArtifactMetadata, SGGenerationReceipt } from 'librechat-data-provider';
import type { MessageMethods } from '@librechat/data-schemas';

const request = {
  userId: 'owner',
  conversationId: 'conversation',
  messageId: 'request',
  provider: 'SG AI Gateway',
  text: 'Create an image: A blue panel.',
};
const identity = {
  userMessageId: 'request',
  responseMessageId: 'actual-response',
  endpoint: 'agents',
  sender: 'SG AI Gateway',
};

function methods() {
  return {
    prepareSGGenerationMessage: jest
      .fn<
        ReturnType<MessageMethods['prepareSGGenerationMessage']>,
        Parameters<MessageMethods['prepareSGGenerationMessage']>
      >()
      .mockImplementation(async (args) => args.receipt),
    cancelSGGenerationMessage: jest
      .fn<
        ReturnType<MessageMethods['cancelSGGenerationMessage']>,
        Parameters<MessageMethods['cancelSGGenerationMessage']>
      >()
      .mockResolvedValue(),
  };
}

test.each(['Hello', 'Explain image generation', 'Quote: Create an image: a panel'])(
  'does not checkpoint ordinary text: %s',
  (text) => {
    expect(createSGGenerationCheckpoint({ ...request, text }, methods())).toBeUndefined();
  },
);
test('temporary generation keeps its existing non-recoverable behavior', () => {
  expect(
    createSGGenerationCheckpoint({ ...request, isTemporary: true }, methods()),
  ).toBeUndefined();
});

test('expired message delivery does not re-register an artifact or query its provider', async () => {
  const resolveEndpoint = jest.fn();
  const createFile = jest.fn();
  const finish = jest.fn();
  expect(
    await recoverSGGenerationMessages({
      userId: 'owner',
      conversationId: 'conversation',
      messages: [
        {
          messageId: 'response',
          isCreatedByUser: false,
          expiredAt: new Date(0),
          metadata: {
            sgGeneration: {
              schema_version: 1,
              requestMessageId: 'request',
              responseMessageId: 'response',
              provider: 'SG AI Gateway',
              kind: 'image',
              state: 'pending',
            },
          },
        },
      ],
      resolveEndpoint,
      createFile,
      finish,
    }),
  ).toBe(false);
  expect(resolveEndpoint).not.toHaveBeenCalled();
  expect(createFile).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});
test('persists the actual response ID and preserves cancellation over registration', async () => {
  const db = methods();
  const checkpoint = createSGGenerationCheckpoint(request, db)!;
  await checkpoint.begin(identity);
  expect(db.prepareSGGenerationMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      receipt: expect.objectContaining({
        requestMessageId: 'request',
        responseMessageId: 'actual-response',
        state: 'pending',
      }),
    }),
  );
  expect(checkpoint.getReceipt(true)?.state).toBe('delivered');
  await checkpoint.cancel();
  expect(checkpoint.getReceipt(true)?.state).toBe('cancelled');
  expect(db.cancelSGGenerationMessage).toHaveBeenCalledWith(
    'owner',
    'conversation',
    'actual-response',
  );
});
test('does not prepare a checkpoint for a different user turn', async () => {
  const db = methods();
  await expect(
    createSGGenerationCheckpoint(request, db)!.begin({ ...identity, userMessageId: 'other' }),
  ).rejects.toThrow('sg_generation_request_mismatch');
  expect(db.prepareSGGenerationMessage).not.toHaveBeenCalled();
});

test('uses the same override identity as BaseClient instead of the optimistic request ID', () => {
  const body = {
    messageId: 'optimistic',
    overrideUserMessageId: `actual${Constants.COMMON_DIVIDER}0`,
  };
  expect(resolveSGRequestMessageId(body)).toBe('actual');
  expect(resolveSGRequestMessageId({ overrideParentMessageId: 'existing-parent' })).toBe(
    'existing-parent',
  );
});
test('reserves a stable BaseClient override when a user ID has not been assigned', () => {
  const body: { overrideUserMessageId?: string } = {};
  const id = resolveSGRequestMessageId(body);
  expect(body.overrideUserMessageId).toBe(`${id}${Constants.COMMON_DIVIDER}0`);
  expect(resolveSGRequestMessageId(body)).toBe(id);
  expect(resolveSGRequestMessageId({})).not.toBe(id);
});

test('recovery retries only registration/conditional persistence, never generation', async () => {
  const receipt: SGGenerationReceipt = {
    schema_version: 1,
    requestMessageId: 'request',
    responseMessageId: 'response',
    provider: 'SG AI Gateway',
    kind: 'image',
    state: 'pending',
  };
  const artifacts: SGArtifactMetadata = {
    schema_version: 1,
    artifacts: [
      {
        schema_version: 1,
        file_id: 'file_result',
        job_id: 'job_result',
        conversation_id: 'conversation',
        display_name: 'result.png',
        mime_type: 'image/png',
        size_bytes: 100,
        sha256: 'a'.repeat(64),
        preview_path: '/internal/files/file_result/image',
        download_path: '/internal/files/file_result/download',
      },
    ],
  };
  const lookup = jest.spyOn(sg, 'getSGGenerationDelivery').mockResolvedValue(artifacts);
  const register = jest
    .spyOn(sg, 'registerSGArtifacts')
    .mockRejectedValueOnce(new Error('storage'))
    .mockResolvedValue();
  const finish = jest.fn().mockResolvedValue(true);
  const args = {
    userId: 'owner',
    conversationId: 'conversation',
    messages: [
      {
        messageId: 'response',
        parentMessageId: 'request',
        isCreatedByUser: false,
        metadata: { sgGeneration: receipt },
      },
    ],
    resolveEndpoint: () => ({
      name: 'SG AI Gateway',
      baseURL: 'http://gateway.invalid/v1',
      apiKey: 'synthetic',
    }),
    createFile: jest.fn(),
    finish,
  };
  try {
    expect(await recoverSGGenerationMessages(args)).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(await recoverSGGenerationMessages(args)).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'request',
        userId: 'owner',
        conversationId: 'conversation',
      }),
    );
    receipt.state = 'cancelled';
    expect(await recoverSGGenerationMessages(args)).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  } finally {
    lookup.mockRestore();
    register.mockRestore();
  }
});
