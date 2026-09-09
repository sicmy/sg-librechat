import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SGGenerationReceipt, SGArtifactMetadata } from 'librechat-data-provider';
import { createMessageMethods } from './message';
import { createResourceDeletionMethods } from './resourceDeletion';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryServer;
const methods = createMessageMethods(mongoose);
const models = createModels(mongoose);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Promise.all([
    models.Message.deleteMany({}),
    models.Conversation.deleteMany({}),
    models.ResourceDeletion.deleteMany({}),
  ]);
});

async function fixture() {
  const conversationId = uuidv4();
  const receipt: SGGenerationReceipt = {
    schema_version: 1,
    requestMessageId: uuidv4(),
    responseMessageId: uuidv4(),
    provider: 'SG AI Gateway',
    kind: 'image',
    state: 'pending',
  };
  await models.Conversation.create({ conversationId, user: 'owner', endpoint: 'agents' });
  await models.Message.create({
    conversationId,
    user: 'owner',
    messageId: receipt.requestMessageId,
    text: 'Create an image: synthetic fixture.',
    isCreatedByUser: true,
  });
  return { userId: 'owner', conversationId, receipt, endpoint: 'agents', sender: 'SG AI Gateway' };
}

test('persists the actual response ID idempotently without copying the prompt', async () => {
  const args = await fixture();
  expect(await methods.prepareSGGenerationMessage(args)).toEqual(args.receipt);
  expect(await methods.prepareSGGenerationMessage(args)).toEqual(args.receipt);
  const response = await models.Message.findOne({ messageId: args.receipt.responseMessageId });
  expect(response?.parentMessageId).toBe(args.receipt.requestMessageId);
  expect(response?.unfinished).toBe(true);
  expect(response?.text).toBe('');
  expect(response?.metadata?.sgGeneration).toEqual(args.receipt);
  expect(await models.Message.countDocuments({ conversationId: args.conversationId })).toBe(2);
});

test.each(['parent', 'conversation', 'owner', 'temporary'])(
  'refuses dispatch checkpoint when the %s precondition is missing',
  async (missing) => {
    const args = await fixture();
    if (missing === 'parent') await models.Message.deleteMany({});
    if (missing === 'conversation') await models.Conversation.deleteMany({});
    if (missing === 'owner') args.userId = 'other';
    if (missing === 'temporary') await models.Message.updateMany({}, { isTemporary: true });
    await expect(methods.prepareSGGenerationMessage(args)).rejects.toThrow(
      'sg_generation_parent_not_persisted',
    );
    expect(await models.Message.countDocuments({ messageId: args.receipt.responseMessageId })).toBe(
      0,
    );
  },
);

test('cancellation is scoped, durable and cannot be replaced by another pending checkpoint', async () => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  await methods.cancelSGGenerationMessage(
    'other',
    args.conversationId,
    args.receipt.responseMessageId,
  );
  expect(
    (await models.Message.findOne({ messageId: args.receipt.responseMessageId }))?.metadata
      ?.sgGeneration,
  ).toMatchObject({ state: 'pending' });
  await methods.cancelSGGenerationMessage(
    args.userId,
    args.conversationId,
    args.receipt.responseMessageId,
  );
  expect(
    (await models.Message.findOne({ messageId: args.receipt.responseMessageId }))?.metadata
      ?.sgGeneration,
  ).toMatchObject({ state: 'cancelled' });
  await expect(methods.prepareSGGenerationMessage(args)).rejects.toThrow(
    'sg_generation_receipt_conflict',
  );
});

test('does not overwrite an existing response or reuse the user message ID', async () => {
  const args = await fixture();
  await models.Message.create({
    user: 'owner',
    conversationId: args.conversationId,
    messageId: args.receipt.responseMessageId,
    text: 'Existing answer',
    isCreatedByUser: false,
  });
  await expect(methods.prepareSGGenerationMessage(args)).rejects.toThrow(
    'sg_generation_receipt_conflict',
  );
  expect((await models.Message.findOne({ messageId: args.receipt.responseMessageId }))?.text).toBe(
    'Existing answer',
  );
  await expect(
    methods.prepareSGGenerationMessage({
      ...args,
      receipt: { ...args.receipt, responseMessageId: args.receipt.requestMessageId },
    }),
  ).rejects.toThrow('sg_generation_invalid_receipt');
});

function artifact(conversationId: string): SGArtifactMetadata {
  return {
    schema_version: 1,
    artifacts: [
      {
        schema_version: 1,
        conversation_id: conversationId,
        file_id: 'file_generated',
        job_id: 'job_generated',
        display_name: 'generated-image.png',
        mime_type: 'image/png',
        size_bytes: 100,
        sha256: 'a'.repeat(64),
        preview_path: '/internal/files/file_generated/image',
        download_path: '/internal/files/file_generated/download',
      },
    ],
  };
}

test('request deletion physically removes an unregistered output manifest even if the receipt was already cancelled', async () => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  await methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) });
  await models.Message.updateOne(
    { messageId: args.receipt.responseMessageId },
    {
      'metadata.sgGeneration.state': 'cancelled',
      files: [{ file_id: 'file_generated' }, { file_id: 'file_unrelated' }],
    },
  );
  await methods.removeSGFileReferences(
    args.userId,
    args.conversationId,
    ['file_original'],
    [args.receipt.requestMessageId],
  );
  const row = await models.Message.findOne({ messageId: args.receipt.responseMessageId });
  expect(row?.metadata?.sgArtifacts).toBeUndefined();
  expect(row?.metadata?.sgGeneration).toMatchObject({ state: 'cancelled' });
  expect(row?.files).toEqual([{ file_id: 'file_unrelated' }]);
  expect(row?.text).toBe('Image generated.');
});

test.each(['prepare', 'finish'])(
  'conversation deletion blocks generation %s even before physical rows are purged',
  async (stage) => {
    const args = await fixture();
    if (stage === 'finish') await methods.prepareSGGenerationMessage(args);
    await createResourceDeletionMethods(mongoose).beginResourceDeletion(args.userId, {
      kind: 'conversation',
      resourceIds: [args.conversationId],
      gateways: [],
    });
    await expect(
      stage === 'prepare'
        ? methods.prepareSGGenerationMessage(args)
        : methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) }),
    ).rejects.toThrow('resource_deleted');
    expect(await models.Message.countDocuments({ 'metadata.sgArtifacts': { $exists: true } })).toBe(
      0,
    );
  },
);

test('generation completion compensates a conversation deletion racing its precheck', async () => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  const exists = models.ResourceDeletion.exists.bind(models.ResourceDeletion);
  const spy = jest.spyOn(models.ResourceDeletion, 'exists').mockImplementationOnce((filter) => {
    const query = exists(filter);
    const exec = query.exec.bind(query);
    jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
      const before = await exec();
      await createResourceDeletionMethods(mongoose).beginResourceDeletion(args.userId, {
        kind: 'conversation',
        resourceIds: [args.conversationId],
        gateways: [],
      });
      return before;
    });
    return query;
  });
  try {
    await expect(
      methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) }),
    ).rejects.toThrow('resource_deleted');
    expect(await models.Message.countDocuments({ conversationId: args.conversationId })).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test('conditionally completes the same response once and preserves unrelated metadata', async () => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  await models.Message.updateOne(
    { messageId: args.receipt.responseMessageId },
    { $set: { 'metadata.keep': 'retained' } },
  );
  const input = { ...args, artifacts: artifact(args.conversationId) };
  expect(await methods.finishSGGenerationMessage(input)).toBe(true);
  expect(await methods.finishSGGenerationMessage(input)).toBe(false);
  const record = await models.Message.findOne({ messageId: args.receipt.responseMessageId });
  expect(record?.metadata).toMatchObject({
    keep: 'retained',
    sgArtifacts: input.artifacts,
    sgGeneration: { state: 'delivered' },
  });
  expect(record?.unfinished).toBe(false);
  expect(record?.text).toBe('Image generated.');
  expect(await models.Message.countDocuments({ conversationId: args.conversationId })).toBe(2);
});

test('file cleanup removes artifacts and quotes but preserves conversation text and unrelated references', async () => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  await methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) });
  const citation = (id: string) => ({
    schema_version: 1,
    citation_id: `cite_${id}`,
    file_id: id,
    display_name: 'source.png',
    mime_type: 'image/png',
    locator: { kind: 'image', image_id: id },
    quote: `quotation from ${id}`,
    relevance_score: 1,
    preview_path: `/internal/files/${id}/image`,
    download_path: `/internal/files/${id}/download`,
  });
  await models.Message.updateOne(
    { messageId: args.receipt.responseMessageId },
    {
      $set: {
        files: [{ file_id: 'file_generated' }, { file_id: 'file_retained' }],
        'metadata.keep': 'untouched',
        'metadata.sgCitations': {
          schema_version: 1,
          citations: [citation('file_generated'), citation('file_retained')],
        },
      },
    },
  );
  await models.Message.create({
    user: 'other',
    conversationId: args.conversationId,
    messageId: uuidv4(),
    isCreatedByUser: false,
    metadata: { sgArtifacts: artifact(args.conversationId) },
  });
  await methods.removeSGFileReferences(
    args.userId,
    args.conversationId,
    ['file_generated'],
    [args.receipt.requestMessageId],
  );
  await methods.removeSGFileReferences(
    args.userId,
    args.conversationId,
    ['file_generated'],
    [args.receipt.requestMessageId],
  );
  const cleaned = await models.Message.findOne({ messageId: args.receipt.responseMessageId });
  expect(cleaned?.metadata?.sgArtifacts).toBeUndefined();
  expect(cleaned?.metadata).toMatchObject({
    keep: 'untouched',
    sgGeneration: { state: 'cancelled' },
    sgCitations: { citations: [citation('file_retained')] },
  });
  expect(cleaned?.files).toEqual([expect.objectContaining({ file_id: 'file_retained' })]);
  expect(cleaned?.text).toBe('Image generated.');
  expect((await models.Message.findOne({ user: 'other' }))?.metadata?.sgArtifacts).toBeDefined();
  expect(
    await methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) }),
  ).toBe(false);
});

test.each([
  'cancelled',
  'deleted-message',
  'deleted-parent',
  'deleted-conversation',
  'expired',
  'replaced',
  'other-user',
])('does not recover a %s response', async (reason) => {
  const args = await fixture();
  await methods.prepareSGGenerationMessage(args);
  const filter = { messageId: args.receipt.responseMessageId };
  if (reason === 'cancelled')
    await methods.cancelSGGenerationMessage(
      args.userId,
      args.conversationId,
      args.receipt.responseMessageId,
    );
  if (reason === 'deleted-message') await models.Message.deleteOne(filter);
  if (reason === 'deleted-parent')
    await models.Message.deleteOne({ messageId: args.receipt.requestMessageId });
  if (reason === 'deleted-conversation')
    await models.Conversation.deleteOne({ conversationId: args.conversationId });
  if (reason === 'expired') await models.Message.updateOne(filter, { expiredAt: new Date(0) });
  if (reason === 'replaced')
    await models.Message.updateOne(filter, {
      $set: { 'metadata.sgGeneration.provider': 'Different provider' },
    });
  if (reason === 'other-user') args.userId = 'other';
  expect(
    await methods.finishSGGenerationMessage({ ...args, artifacts: artifact(args.conversationId) }),
  ).toBe(false);
  expect((await models.Message.findOne(filter))?.metadata?.sgArtifacts).toBeUndefined();
});
