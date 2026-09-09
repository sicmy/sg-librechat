import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources } from 'librechat-data-provider';
import { createMethods, createModels, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import {
  deleteSGConversationResources,
  deleteSGFileResources,
  deleteExpiredSGFile,
} from './lifecycle';
import {
  runSGFileDeletionPass,
  startSGFileDeletionWorker,
  runSGReconciliationPass,
  runSGSearchCleanup,
} from './deletionWorker';
import {
  deleteSGConversations,
  resumeSGConversationDeletion,
  reconcileSGDeletion,
  sweepSGExpiredConversations,
  sweepSGExpiredMessages,
} from './conversations';
import * as sg from './sg';
import {
  loadSGTerminalSnapshot,
  refreshSGReplayFinal,
  filterSGResumeFiles,
  filterSGPendingSteerFiles,
  needsSGReplayRefresh,
} from './delivery';

const owner = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
const models = createModels(mongoose);
const methods = createMethods(mongoose);
const appConfig = {
  config: {},
  fileStrategy: FileSources.local,
  imageOutputType: 'png',
  endpoints: {
    custom: [
      {
        name: 'SG AI Gateway',
        baseURL: 'http://gateway.invalid/v1',
        apiKey: 'synthetic',
        models: { default: ['default'] },
        customParams: { sgFileGateway: true, defaultParamsEndpoint: 'custom' },
      },
    ],
  },
} satisfies AppConfig;
let server: MongoMemoryServer;
let removeConversation: jest.SpyInstance;
let removeFile: jest.SpyInstance;
beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'ttlMonitorEnabled=false'] },
  });
  await mongoose.connect(server.getUri());
  await Promise.all(Object.values(models).map((model) => model.init()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await runAsSystem(async () =>
    Promise.all([
      models.Message.deleteMany({}),
      models.File.deleteMany({}),
      models.Conversation.deleteMany({}),
      models.ResourceDeletion.deleteMany({}),
      models.SharedLink.deleteMany({}),
      models.ToolCall.deleteMany({}),
    ]),
  );
  removeConversation = jest.spyOn(sg, 'deleteSGGatewayConversation').mockResolvedValue();
  removeFile = jest.spyOn(sg, 'deleteSGGatewayFile').mockResolvedValue();
});
afterEach(() => jest.restoreAllMocks());

async function file(conversationId: string, user = owner) {
  return models.File.create({
    user,
    conversationId,
    file_id: uuidv4(),
    filename: 'generated-image.png',
    filepath: '/api/files/sg-image/synthetic',
    bytes: 100,
    type: 'image/png',
    source: FileSources.sg_gateway,
    metadata: {
      sgGateway: {
        endpoint: 'SG AI Gateway',
        conversationId,
        jobId: 'job_generated',
        state: 'READY',
      },
    },
  });
}
const remove = (ids: string[]) =>
  deleteSGConversationResources({
    userId: owner.toString(),
    conversationIds: ids,
    appConfig,
    methods,
  });

test('deletes generated-only file records and never follows a forged foreign-conversation reference', async () => {
  const selected = uuidv4();
  const generated = await file(selected);
  const unrelated = await file(uuidv4());
  const foreignOwner = await file(selected, other);
  await models.Message.create({
    user: owner.toString(),
    conversationId: selected,
    messageId: uuidv4(),
    isCreatedByUser: true,
    files: [{ file_id: unrelated.file_id }],
  });
  await remove([selected]);
  expect(await models.File.findOne({ file_id: generated.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: unrelated.file_id })).not.toBeNull();
  expect(await models.File.findOne({ file_id: foreignOwner.file_id })).not.toBeNull();
  expect(removeConversation).toHaveBeenCalledTimes(1);
  expect(removeConversation).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: selected, userId: owner.toString() }),
  );
  expect(removeFile).not.toHaveBeenCalled();
});

test('closes an empty selected scope to cover generation that has not registered its output yet', async () => {
  const selected = uuidv4();
  await remove([selected]);
  expect(removeConversation).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: selected }),
  );
});

test('preserves local records if gateway deletion fails', async () => {
  const selected = uuidv4();
  const generated = await file(selected);
  removeConversation.mockRejectedValue(new sg.SGFileGatewayError(503, 'unavailable'));
  await expect(remove([selected])).rejects.toThrow('unavailable');
  expect(await models.File.findOne({ file_id: generated.file_id })).not.toBeNull();
});

test('preserves a shared legacy draft for another conversation and cleans it in a selected bulk deletion', async () => {
  const first = uuidv4(),
    second = uuidv4();
  const legacy = await file('draft-legacy');
  for (const conversationId of [first, second]) {
    await models.Message.create({
      user: owner.toString(),
      conversationId,
      messageId: uuidv4(),
      isCreatedByUser: true,
      files: [{ file_id: legacy.file_id }],
    });
  }
  await remove([first]);
  expect(removeFile).not.toHaveBeenCalled();
  expect(await models.File.findOne({ file_id: legacy.file_id })).not.toBeNull();
  await remove([first, second]);
  expect(removeConversation).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: 'draft-legacy' }),
  );
  expect(await models.File.findOne({ file_id: legacy.file_id })).toBeNull();
});

test('cleans a legacy namespace when its last referencing conversation is deleted later', async () => {
  const first = uuidv4(),
    last = uuidv4();
  const legacy = await file('draft-shared');
  await models.File.updateOne({ file_id: legacy.file_id }, { conversationId: first });
  for (const conversationId of [first, last]) {
    await models.Conversation.create({
      user: owner.toString(),
      conversationId,
      endpoint: 'agents',
    });
    await models.Message.create({
      user: owner.toString(),
      conversationId,
      messageId: uuidv4(),
      isCreatedByUser: true,
      files: [{ file_id: legacy.file_id }],
    });
  }
  await remove([first]);
  expect(await models.File.findOne({ file_id: legacy.file_id })).not.toBeNull();
  await models.Conversation.deleteOne({ conversationId: first });
  await models.Message.deleteMany({ conversationId: first });
  await remove([last]);
  expect(await models.File.findOne({ file_id: legacy.file_id })).toBeNull();
  expect(removeConversation).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: 'draft-shared' }),
  );
});

test('selects deletion IDs by owner and includes archived conversations', async () => {
  const first = uuidv4(),
    archived = uuidv4(),
    foreign = uuidv4();
  await models.Conversation.create([
    { user: owner.toString(), conversationId: first, endpoint: 'agents' },
    { user: owner.toString(), conversationId: archived, endpoint: 'agents', isArchived: true },
    { user: other.toString(), conversationId: foreign, endpoint: 'agents' },
  ]);
  expect(new Set(await methods.getConversationsForDeletion(owner.toString()))).toEqual(
    new Set([first, archived]),
  );
  expect(await methods.getConversationsForDeletion(owner.toString(), foreign)).toEqual([]);
  await expect(methods.getConversationsForDeletion(owner.toString(), '')).rejects.toThrow(
    'invalid_conversation_deletion_scope',
  );
});

test('explicit owned-file deletion never widens to all user files or another owner', async () => {
  const selected = await file(uuidv4());
  const retained = await file(uuidv4());
  const foreign = await file(uuidv4(), other);
  expect(await methods.deleteOwnedFiles([], { userId: owner.toString() })).toEqual({
    deletedCount: 0,
  });
  await methods.deleteOwnedFiles([selected.file_id, foreign.file_id], { userId: owner.toString() });
  expect(await models.File.findOne({ file_id: selected.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: retained.file_id })).not.toBeNull();
  expect(await models.File.findOne({ file_id: foreign.file_id })).not.toBeNull();
});

test('resolves process-provided endpoint references without reading an env file', async () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    SG_LIFECYCLE_TEST_KEY: 'provided-locally',
    SG_LIFECYCLE_TEST_URL: 'http://gateway.invalid/v1',
  });
  const config: AppConfig = {
    ...appConfig,
    endpoints: {
      custom: [
        {
          ...appConfig.endpoints!.custom![0],
          apiKey: '${SG_LIFECYCLE_TEST_KEY}',
          baseURL: '${SG_LIFECYCLE_TEST_URL}',
        },
      ],
    },
  };
  await deleteSGConversationResources({
    userId: owner.toString(),
    conversationIds: [uuidv4()],
    appConfig: config,
    methods,
  });
  expect(removeConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      endpointConfig: expect.objectContaining({
        apiKey: 'provided-locally',
        baseURL: 'http://gateway.invalid/v1',
      }),
    }),
  );
});

test('file-tree cleanup retains its root until message and child cleanup have succeeded', async () => {
  const conversationId = uuidv4();
  const root = await file(conversationId),
    child = await file(conversationId),
    retained = await file(conversationId);
  const report = jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockResolvedValue({
    schema_version: 1,
    file_id: root.file_id,
    conversation_id: conversationId,
    deleted_file_ids: [root.file_id, child.file_id],
    request_message_ids: [],
  });
  const cleanup = jest
    .spyOn(methods, 'removeSGFileReferences')
    .mockRejectedValueOnce(new Error('synthetic_message_cleanup_failure'));
  const args = {
    file: root,
    userId: owner.toString(),
    endpointConfig: appConfig.endpoints!.custom![0],
    methods,
  };
  await expect(deleteSGFileResources(args)).rejects.toThrow('synthetic_message_cleanup_failure');
  expect(await models.File.findOne({ file_id: root.file_id })).not.toBeNull();
  expect(await models.File.findOne({ file_id: child.file_id })).not.toBeNull();
  cleanup.mockRestore();
  expect(await deleteSGFileResources(args)).toEqual([root.file_id, child.file_id]);
  expect(await models.File.findOne({ file_id: root.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: child.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: retained.file_id })).not.toBeNull();
  expect(report).toHaveBeenCalledTimes(1);
});

test('the worker resumes a recorded remote result without a local root or provider configuration', async () => {
  const conversationId = uuidv4();
  const root = await file(conversationId),
    child = await file(conversationId),
    kept = await file(conversationId);
  const report = jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockResolvedValue({
    schema_version: 1,
    file_id: root.file_id,
    conversation_id: conversationId,
    deleted_file_ids: [root.file_id, child.file_id],
    request_message_ids: [],
  });
  const failure = jest
    .spyOn(methods, 'removeSGFileReferences')
    .mockRejectedValueOnce(new Error('synthetic_failure'));
  await expect(
    deleteSGFileResources({
      file: root,
      userId: owner.toString(),
      endpointConfig: appConfig.endpoints!.custom![0],
      methods,
    }),
  ).rejects.toThrow('synthetic_failure');
  failure.mockRestore();
  await models.File.deleteOne({ file_id: root.file_id });
  const loadConfig = jest
    .fn()
    .mockRejectedValue(new Error('configuration must not be required after remote cleanup'));
  const reopened = createMethods(mongoose);
  expect(await runSGFileDeletionPass({ methods: reopened, loadConfig })).toEqual({
    completed: 1,
    failed: 0,
  });
  expect(loadConfig).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledTimes(1);
  expect(await models.File.findOne({ file_id: child.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: kept.file_id })).not.toBeNull();
  expect((await models.ResourceDeletion.findOne({ userId: owner.toString() }))?.state).toBe(
    'complete',
  );
});

test('the worker restores each tenant and owner and ignores conversation jobs and active leases', async () => {
  const remote = jest
    .spyOn(sg, 'deleteSGGatewayScopedFileTree')
    .mockImplementation(async (args) => ({
      schema_version: 1,
      file_id: args.fileId,
      conversation_id: args.conversationId,
      deleted_file_ids: [args.fileId],
      request_message_ids: [],
    }));
  const loadConfig = jest.fn(async (tenantId?: string) => {
    expect(tenantStorage.getStore()).toEqual({ tenantId, userId: owner.toString() });
    return appConfig;
  });
  for (const tenantId of ['tenant-a', 'tenant-b']) {
    await tenantStorage.run({ tenantId, userId: owner.toString() }, async () => {
      const root = await file(uuidv4());
      await methods.beginResourceDeletion(owner.toString(), {
        kind: 'file',
        resourceIds: [root.file_id],
        gateways: [{ endpoint: 'SG AI Gateway', conversationId: root.conversationId! }],
      });
    });
  }
  const conversation = await methods.beginResourceDeletion(owner.toString(), {
    kind: 'conversation',
    resourceIds: [uuidv4()],
    gateways: [],
  });
  const leased = await methods.beginResourceDeletion(owner.toString(), {
    kind: 'file',
    resourceIds: [uuidv4()],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: uuidv4() }],
  });
  await methods.claimResourceDeletion(owner.toString(), leased._id);
  expect(await runSGFileDeletionPass({ methods, loadConfig })).toEqual({ completed: 2, failed: 0 });
  expect(loadConfig.mock.calls.map(([tenant]) => tenant).sort()).toEqual(['tenant-a', 'tenant-b']);
  expect(remote).toHaveBeenCalledTimes(2);
  expect(await runAsSystem(async () => models.File.countDocuments())).toBe(0);
  expect((await methods.getResourceDeletion(owner.toString(), conversation._id))?.state).toBe(
    'pending',
  );
  expect((await methods.getResourceDeletion(owner.toString(), leased._id))?.attempts).toBe(1);
});

test('failed gateway cleanup stays queued without removing local data and does not starve later work', async () => {
  const failedRoot = await file(uuidv4());
  const goodRoot = await file(uuidv4());
  const jobs = [];
  for (const root of [failedRoot, goodRoot]) {
    jobs.push(
      await methods.beginResourceDeletion(owner.toString(), {
        kind: 'file',
        resourceIds: [root.file_id],
        gateways: [{ endpoint: 'SG AI Gateway', conversationId: root.conversationId! }],
      }),
    );
  }
  await models.ResourceDeletion.updateOne(
    { _id: jobs[0]._id },
    { updatedAt: new Date(0) },
    { timestamps: false },
  );
  jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockImplementation(async (args) => {
    if (args.fileId === failedRoot.file_id)
      throw new sg.SGFileGatewayError(503, 'synthetic_unavailable');
    return {
      schema_version: 1,
      file_id: args.fileId,
      conversation_id: args.conversationId,
      deleted_file_ids: [args.fileId],
      request_message_ids: [],
    };
  });
  const options = { methods, loadConfig: async () => appConfig, batchSize: 1 };
  expect(await runSGFileDeletionPass(options)).toEqual({ completed: 0, failed: 1 });
  expect(await models.File.findOne({ file_id: failedRoot.file_id })).not.toBeNull();
  const failed = await methods.getResourceDeletion(owner.toString(), jobs[0]._id);
  expect(failed).toMatchObject({
    state: 'pending',
    remoteComplete: false,
    leaseToken: null,
    errorCode: 'cleanup_failed',
  });
  expect(await runSGFileDeletionPass(options)).toEqual({ completed: 1, failed: 0 });
  expect(await models.File.findOne({ file_id: goodRoot.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: failedRoot.file_id })).not.toBeNull();
});

test('expiry discovery failure does not prevent pending deletion recovery', async () => {
  const discover = jest.spyOn(methods, 'listPendingResourceDeletions');
  const stop = startSGFileDeletionWorker({
    methods,
    loadConfig: async () => appConfig,
    expireConversations: async () => {
      throw new Error('synthetic_expiry_failure');
    },
  });
  await stop();
  expect(discover).toHaveBeenCalledTimes(1);
});

test('expired conversation cleanup removes its resources and preserves future conversations', async () => {
  const expired = await conversation();
  const future = await conversation(other);
  await file(expired);
  await models.Conversation.updateOne({ conversationId: expired }, { expiredAt: new Date(0) });
  await models.Conversation.updateOne(
    { conversationId: future },
    { expiredAt: new Date('2100-01-01') },
  );
  expect(await sweepSGExpiredConversations({ methods, loadConfig: async () => appConfig })).toEqual(
    {
      scanned: 1,
      deleted: 1,
      retained: 0,
      failed: 0,
    },
  );
  expect(await models.Conversation.countDocuments({ conversationId: expired })).toBe(0);
  expect(await models.File.countDocuments({ conversationId: expired })).toBe(0);
  expect(await models.Conversation.countDocuments({ conversationId: future })).toBe(1);
});

test('conversation expiry rechecks a renewed deadline before deleting', async () => {
  const id = await conversation();
  await models.Conversation.updateOne({ conversationId: id }, { expiredAt: new Date(0) });
  const discover = methods.getExpiredConversations;
  jest.spyOn(methods, 'getExpiredConversations').mockImplementation(async (...args) => {
    const rows = await discover(...args);
    await models.Conversation.updateOne(
      { conversationId: id },
      { expiredAt: new Date('2100-01-01') },
    );
    return rows;
  });
  expect(await sweepSGExpiredConversations({ methods, loadConfig: async () => appConfig })).toEqual(
    {
      scanned: 1,
      deleted: 0,
      retained: 1,
      failed: 0,
    },
  );
  expect(await models.ResourceDeletion.countDocuments()).toBe(0);
  expect(removeConversation).not.toHaveBeenCalled();
});

test('failed expired conversation cleanup preserves its row and a pending retry', async () => {
  const id = await conversation();
  await models.Conversation.updateOne({ conversationId: id }, { expiredAt: new Date(0) });
  removeConversation.mockRejectedValueOnce(new Error('synthetic_unavailable'));
  expect(await sweepSGExpiredConversations({ methods, loadConfig: async () => appConfig })).toEqual(
    {
      scanned: 1,
      deleted: 0,
      retained: 0,
      failed: 1,
    },
  );
  expect(await models.Conversation.countDocuments({ conversationId: id })).toBe(1);
  expect(await models.ResourceDeletion.countDocuments({ state: 'pending' })).toBe(1);
});

test('expired messages lose content while live parents retain file references until conversation deletion', async () => {
  const id = await conversation();
  const root = await models.File.findOne({ conversationId: id });
  await models.Message.updateMany(
    { conversationId: id },
    { expiredAt: new Date(0), files: [{ file_id: root!.file_id, filename: 'private filename' }] },
  );
  expect(await sweepSGExpiredMessages({ methods, loadConfig: async () => appConfig })).toEqual({
    compacted: 1,
    orphaned: 0,
    deleted: 0,
    failed: 0,
  });
  const compacted = await models.Message.findOne({ conversationId: id }).lean();
  expect(compacted?.text).toBeUndefined();
  expect(compacted?.files).toEqual([{ file_id: root!.file_id }]);
  expect(await models.File.countDocuments({ conversationId: id })).toBe(1);
  await models.Conversation.updateOne({ conversationId: id }, { expiredAt: new Date(0) });
  expect(
    await sweepSGExpiredConversations({ methods, loadConfig: async () => appConfig }),
  ).toMatchObject({ deleted: 1, failed: 0 });
  expect(await models.Message.countDocuments({ conversationId: id })).toBe(0);
  expect(await models.File.countDocuments({ conversationId: id })).toBe(0);
});

test('orphan expiry uses the durable deletion path and retries after Gateway failure', async () => {
  const id = await conversation();
  await models.Message.updateMany({ conversationId: id }, { expiredAt: new Date(0) });
  await models.Conversation.deleteOne({ conversationId: id });
  removeConversation.mockRejectedValueOnce(new Error('synthetic_unavailable'));
  expect(await sweepSGExpiredMessages({ methods, loadConfig: async () => appConfig })).toEqual({
    compacted: 1,
    orphaned: 1,
    deleted: 0,
    failed: 1,
  });
  expect((await models.Message.findOne({ conversationId: id }).lean())?.text).toBeUndefined();
  expect(await models.File.countDocuments({ conversationId: id })).toBe(1);
  expect((await methods.findResourceDeletion(owner.toString(), 'conversation', [id]))?.state).toBe(
    'pending',
  );
  expect(
    await sweepSGExpiredMessages({ methods, loadConfig: async () => appConfig }),
  ).toMatchObject({ orphaned: 1, deleted: 1, failed: 0 });
  expect(await models.Message.countDocuments({ conversationId: id })).toBe(0);
  expect(await models.File.countDocuments({ conversationId: id })).toBe(0);
});

test('search cleanup failures do not prevent other indexes from being processed', async () => {
  const healthy = jest.fn(async () => ({ scanned: 1, deleted: 1, complete: true }));
  expect(
    await runSGSearchCleanup([
      {
        sweepMeiliIndex: async () => {
          throw new Error('synthetic_unavailable');
        },
      },
      { sweepMeiliIndex: healthy },
      {},
    ]),
  ).toEqual({ completed: 1, failed: 1 });
  expect(healthy).toHaveBeenCalledTimes(1);
});

test('worker shutdown also waits for an active search cleanup', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = startSGFileDeletionWorker({
    methods,
    loadConfig: async () => appConfig,
    cleanupSearch: async () => {
      entered();
      await held;
    },
  });
  await started;
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(stopped).toBe(true);
});

test('worker shutdown waits for its active pass and does not schedule another one', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discover = methods.listPendingResourceDeletions;
  const calls = jest
    .spyOn(methods, 'listPendingResourceDeletions')
    .mockImplementation(async (...args) => {
      await held;
      return discover(...args);
    });
  const stop = startSGFileDeletionWorker({
    methods,
    loadConfig: async () => appConfig,
    intervalMs: 1000,
  });
  expect(calls).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(calls).toHaveBeenCalledTimes(1);
});

async function conversation(user = owner) {
  const conversationId = uuidv4();
  await models.Conversation.create({
    user: user.toString(),
    conversationId,
    endpoint: 'SG AI Gateway',
  });
  await models.Message.create({
    user: user.toString(),
    conversationId,
    messageId: uuidv4(),
    isCreatedByUser: true,
    text: 'retained until deletion',
  });
  await models.SharedLink.create({ user: user.toString(), conversationId, shareId: uuidv4() });
  await models.ToolCall.create({ user, conversationId, messageId: uuidv4(), toolId: 'synthetic' });
  await file(conversationId, user);
  return conversationId;
}
const deleteConversations = (conversationIds: string[]) =>
  deleteSGConversations({
    userId: owner.toString(),
    conversationIds,
    appConfig,
    methods,
  });

test('journaled conversation deletion removes owned files, messages, links and tools, preserving unselected and other owners', async () => {
  const selected = await conversation(),
    kept = await conversation(),
    foreign = await conversation(other);
  expect((await deleteConversations([selected])).deletedCount).toBe(1);
  for (const model of [
    models.Conversation,
    models.Message,
    models.File,
    models.SharedLink,
    models.ToolCall,
  ]) {
    expect(await model.countDocuments({ conversationId: selected })).toBe(0);
    expect(await model.countDocuments({ conversationId: kept })).toBe(1);
    expect(await model.countDocuments({ conversationId: foreign })).toBe(1);
  }
  expect(
    (await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]))?.state,
  ).toBe('complete');
  expect((await deleteConversations([selected])).deletedCount).toBe(0);
  expect(removeConversation).toHaveBeenCalledTimes(1);
});

test('conversation worker retries a failed local cleanup after the conversation row is already gone', async () => {
  const selected = await conversation(),
    kept = await conversation();
  jest
    .spyOn(models.Message, 'deleteMany')
    .mockRejectedValueOnce(new Error('synthetic_inner_message_failure'));
  const fail = jest
    .spyOn(methods, 'deleteMessages')
    .mockRejectedValueOnce(new Error('synthetic_message_failure'));
  await expect(deleteConversations([selected])).rejects.toThrow('synthetic_message_failure');
  fail.mockRestore();
  expect(await models.Conversation.findOne({ conversationId: selected })).toBeNull();
  expect(await models.Message.countDocuments({ conversationId: selected })).toBe(1);
  const job = await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]);
  expect(job).toMatchObject({ state: 'pending', remoteComplete: true });
  const reopened = createMethods(mongoose);
  expect(
    await runSGFileDeletionPass({
      methods: reopened,
      loadConfig: async () => appConfig,
      resumeConversation: async (pending) => {
        await resumeSGConversationDeletion({
          job: pending,
          methods: reopened,
          loadConfig: async () => appConfig,
        });
      },
    }),
  ).toEqual({ completed: 1, failed: 0 });
  expect(removeConversation).toHaveBeenCalledTimes(1);
  expect(await models.SharedLink.countDocuments({ conversationId: selected })).toBe(0);
  expect(await models.Message.countDocuments({ conversationId: selected })).toBe(0);
  expect(await models.ToolCall.countDocuments({ conversationId: selected })).toBe(0);
  expect(await models.Conversation.countDocuments({ conversationId: kept })).toBe(1);
  expect((await methods.getResourceDeletion(owner.toString(), job!._id))?.state).toBe('complete');
});

test('unavailable Gateway preserves a durable conversation snapshot and retry does not expand to new conversations', async () => {
  const first = await conversation(),
    second = await conversation();
  await models.Conversation.updateOne({ conversationId: second }, { isArchived: true });
  removeConversation.mockRejectedValueOnce(
    new sg.SGFileGatewayError(503, 'synthetic_gateway_failure'),
  );
  await expect(deleteConversations([first, second])).rejects.toThrow('synthetic_gateway_failure');
  const job = await methods.findResourceDeletion(owner.toString(), 'conversation', [second, first]);
  expect(job).toMatchObject({ state: 'pending', remoteComplete: false });
  expect(job!.fileIds).toHaveLength(2);
  expect(await models.Conversation.countDocuments()).toBe(2);
  const newer = await conversation();
  await deleteConversations([second, first]);
  expect(await models.Conversation.countDocuments()).toBe(1);
  expect(await models.SharedLink.countDocuments({ conversationId: newer })).toBe(1);
  expect(await models.ToolCall.countDocuments({ conversationId: newer })).toBe(1);
});

test('unowned conversation and empty selections cannot create deletion work or remove data', async () => {
  const foreign = await conversation(other);
  await expect(deleteConversations([foreign])).rejects.toThrow('conversation_not_found');
  expect((await deleteConversations([])).deletedCount).toBe(0);
  expect(await models.ResourceDeletion.countDocuments()).toBe(0);
  expect(removeConversation).not.toHaveBeenCalled();
  expect(await models.Conversation.countDocuments()).toBe(1);
});

test('strict shared-link cleanup retains retry evidence when permission deletion fails', async () => {
  const selected = await conversation();
  jest
    .spyOn(models.AclEntry, 'deleteMany')
    .mockRejectedValueOnce(new Error('synthetic_acl_failure'));
  await expect(deleteConversations([selected])).rejects.toThrow('synthetic_acl_failure');
  expect(await models.SharedLink.countDocuments({ conversationId: selected })).toBe(1);
  expect(
    (await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]))?.state,
  ).toBe('pending');
  await deleteConversations([selected]);
  expect(await models.SharedLink.countDocuments({ conversationId: selected })).toBe(0);
  expect(
    (await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]))?.state,
  ).toBe('complete');
});

test('journal read filtering preserves a protected legacy file until its last conversation is deleted', async () => {
  const first = await conversation(),
    last = await conversation();
  const legacy = await file('draft-read-shared');
  await models.File.updateOne({ file_id: legacy.file_id }, { conversationId: first });
  for (const conversationId of [first, last]) {
    await models.Message.create({
      user: owner.toString(),
      conversationId,
      messageId: uuidv4(),
      isCreatedByUser: true,
      files: [{ file_id: legacy.file_id }],
    });
  }
  await deleteConversations([first]);
  expect(
    (await methods.findResourceDeletion(owner.toString(), 'conversation', [first]))
      ?.protectedFileIds,
  ).toEqual([legacy.file_id]);
  expect(await methods.findFileById(legacy.file_id)).not.toBeNull();
  expect((await methods.getFiles({ user: owner }))?.map((row) => row.file_id)).toContain(
    legacy.file_id,
  );
  await deleteConversations([last]);
  expect(await methods.findFileById(legacy.file_id)).toBeNull();
  expect(await models.File.findOne({ file_id: legacy.file_id })).toBeNull();
});

const reconcile = () =>
  runSGReconciliationPass({
    methods,
    loadConfig: async () => appConfig,
    reconcile: (job) => reconcileSGDeletion({ job, methods, loadConfig: async () => appConfig }),
  });
test('completed conversation reconciliation removes raw late rows without another Gateway request', async () => {
  const selected = await conversation(),
    kept = await conversation();
  await deleteConversations([selected]);
  await models.Conversation.create({
    user: owner.toString(),
    conversationId: selected,
    endpoint: 'SG AI Gateway',
  });
  await models.Message.create({
    user: owner.toString(),
    conversationId: selected,
    messageId: uuidv4(),
    isCreatedByUser: false,
  });
  await models.SharedLink.create({ user: owner.toString(), conversationId: selected });
  await models.ToolCall.create({
    user: owner,
    conversationId: selected,
    messageId: uuidv4(),
    toolId: 'late',
  });
  await file(selected);
  expect(await methods.getConvo(owner.toString(), selected)).toBeNull();
  expect(await models.Conversation.countDocuments({ conversationId: selected })).toBe(1);
  expect(await reconcile()).toEqual({ reconciled: 1, failed: 0 });
  for (const model of [
    models.Conversation,
    models.Message,
    models.File,
    models.SharedLink,
    models.ToolCall,
  ]) {
    expect(await model.countDocuments({ conversationId: selected })).toBe(0);
    expect(await model.countDocuments({ conversationId: kept })).toBe(1);
  }
  expect(removeConversation).toHaveBeenCalledTimes(1);
  expect(
    await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]),
  ).toMatchObject({ state: 'complete', attempts: 1, reconcileAttempts: 1 });
});

test('completed file reconciliation clears reinserted file IDs and references without removing unrelated message text', async () => {
  const id = uuidv4();
  const root = await file(id),
    kept = await file(id);
  const report = jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockResolvedValue({
    schema_version: 1,
    file_id: root.file_id,
    conversation_id: id,
    deleted_file_ids: [root.file_id],
    request_message_ids: [],
  });
  await deleteSGFileResources({
    file: root,
    userId: owner.toString(),
    endpointConfig: appConfig.endpoints.custom[0],
    methods,
  });
  const late = await file(id);
  await models.File.updateOne({ file_id: late.file_id }, { file_id: root.file_id });
  await models.Message.create({
    user: owner.toString(),
    conversationId: id,
    messageId: uuidv4(),
    isCreatedByUser: true,
    text: 'keep text',
    files: [{ file_id: root.file_id }, { file_id: kept.file_id }],
  });
  expect(await reconcile()).toEqual({ reconciled: 1, failed: 0 });
  expect(await models.File.findOne({ file_id: root.file_id })).toBeNull();
  expect(await models.File.findOne({ file_id: kept.file_id })).not.toBeNull();
  expect(await models.Message.findOne({ conversationId: id }).lean()).toMatchObject({
    text: 'keep text',
    files: [{ file_id: kept.file_id }],
  });
  expect(report).toHaveBeenCalledTimes(1);
});

test('reconciliation preserves protected files and a different endpoint sharing the same legacy scope name', async () => {
  const selected = uuidv4();
  const protectedFile = await file(selected),
    matching = await file('draft-collision'),
    foreignEndpoint = await file('draft-collision');
  await models.File.updateOne(
    { file_id: foreignEndpoint.file_id },
    { 'metadata.sgGateway.endpoint': 'Unrelated Gateway' },
  );
  const job = await methods.beginResourceDeletion(owner.toString(), {
    kind: 'conversation',
    resourceIds: [selected],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: 'draft-collision' }],
    protectedFileIds: [protectedFile.file_id],
  });
  const lease = await methods.claimResourceDeletion(owner.toString(), job._id);
  await methods.recordResourceDeletionTargets(
    owner.toString(),
    job._id,
    lease!.leaseToken!,
    [],
    [],
  );
  await methods.finishResourceDeletion(owner.toString(), job._id, lease!.leaseToken!);
  expect(await methods.findFileById(foreignEndpoint.file_id)).not.toBeNull();
  expect(await reconcile()).toEqual({ reconciled: 1, failed: 0 });
  expect(await models.File.findOne({ file_id: matching.file_id })).toBeNull();
  expect(await methods.findFileById(protectedFile.file_id)).not.toBeNull();
  expect(await methods.findFileById(foreignEndpoint.file_id)).not.toBeNull();
  expect(removeConversation).not.toHaveBeenCalled();
});

test('failed reconciliation remains completed and retries its leftover records', async () => {
  const selected = await conversation();
  await deleteConversations([selected]);
  await models.Message.create({
    user: owner.toString(),
    conversationId: selected,
    messageId: uuidv4(),
    isCreatedByUser: true,
  });
  const failure = jest
    .spyOn(methods, 'deleteMessages')
    .mockRejectedValueOnce(new Error('synthetic_reconciliation_failure'));
  expect(await reconcile()).toEqual({ reconciled: 0, failed: 1 });
  failure.mockRestore();
  expect(await models.Message.countDocuments({ conversationId: selected })).toBe(1);
  expect(
    await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]),
  ).toMatchObject({ state: 'complete', reconcileFailed: true, attempts: 1 });
  expect(await reconcile()).toEqual({ reconciled: 1, failed: 0 });
  expect(await models.Message.countDocuments({ conversationId: selected })).toBe(0);
  expect(
    await methods.findResourceDeletion(owner.toString(), 'conversation', [selected]),
  ).toMatchObject({ state: 'complete', reconcileFailed: false, attempts: 1, reconcileAttempts: 2 });
});

test('file deletion discovers and persists source chains and late request outputs before removing references', async () => {
  const id = uuidv4(),
    requestId = uuidv4();
  const root = await file(id),
    child = await file(id),
    grandchild = await file(id),
    requestOutput = await file(id),
    kept = await file(id);
  await models.File.updateOne(
    { file_id: child.file_id },
    { 'metadata.sgGateway.sourceFileId': root.file_id },
  );
  await models.File.updateOne(
    { file_id: grandchild.file_id },
    { 'metadata.sgGateway.sourceFileId': child.file_id },
  );
  await models.File.updateOne(
    { file_id: requestOutput.file_id },
    { 'metadata.sgGateway.requestMessageId': requestId },
  );
  const remote = jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockResolvedValue({
    schema_version: 1,
    file_id: root.file_id,
    conversation_id: id,
    deleted_file_ids: [root.file_id],
    request_message_ids: [requestId],
  });
  const deleted = await deleteSGFileResources({
    file: root,
    userId: owner.toString(),
    endpointConfig: appConfig.endpoints.custom[0],
    methods,
  });
  expect(new Set(deleted)).toEqual(
    new Set([root.file_id, child.file_id, grandchild.file_id, requestOutput.file_id]),
  );
  expect(await models.File.countDocuments()).toBe(1);
  expect(await models.File.findOne({ file_id: kept.file_id })).not.toBeNull();
  expect(
    new Set(
      (await methods.findResourceDeletion(owner.toString(), 'file', [root.file_id]))!.fileIds,
    ),
  ).toEqual(new Set(deleted));
  const later = await file(id),
    laterChild = await file(id);
  await models.File.updateOne(
    { file_id: later.file_id },
    { 'metadata.sgGateway.sourceFileId': root.file_id },
  );
  await models.File.updateOne(
    { file_id: laterChild.file_id },
    { 'metadata.sgGateway.sourceFileId': later.file_id },
  );
  expect(await reconcile()).toEqual({ reconciled: 1, failed: 0 });
  expect(await models.File.countDocuments()).toBe(1);
  expect(
    (await methods.findResourceDeletion(owner.toString(), 'file', [root.file_id]))?.fileIds,
  ).toEqual(expect.arrayContaining([later.file_id, laterChild.file_id]));
  expect(remote).toHaveBeenCalledTimes(1);
});

async function terminalFixture() {
  const conversationId = await conversation();
  const parent = (await models.Message.findOne({ conversationId }))!;
  const root = (await models.File.findOne({ conversationId }))!;
  const responseMessageId = uuidv4();
  await models.Message.updateOne(
    { messageId: parent.messageId },
    { files: [{ file_id: root.file_id }] },
  );
  await models.Message.create({
    user: owner.toString(),
    conversationId,
    messageId: responseMessageId,
    parentMessageId: parent.messageId,
    isCreatedByUser: false,
    text: 'synthetic terminal body',
    metadata: {
      sgArtifacts: {
        schema_version: 1,
        artifacts: [
          {
            schema_version: 1,
            file_id: root.file_id,
            conversation_id: conversationId,
            job_id: 'job_generated',
            display_name: 'generated-image.png',
            mime_type: 'image/png',
            size_bytes: 100,
            sha256: 'a'.repeat(64),
            preview_path: `/internal/files/${root.file_id}/image`,
            download_path: `/internal/files/${root.file_id}/download`,
          },
        ],
      },
    },
  });
  return {
    userId: owner.toString(),
    conversationId,
    requestMessageId: parent.messageId,
    responseMessageId,
    methods,
    fileId: root.file_id,
  };
}

test('terminal snapshot replaces cached request and response references after file deletion', async () => {
  const args = await terminalFixture();
  const cached = await loadSGTerminalSnapshot(args);
  expect(cached.response.metadata?.sgArtifacts).toBeDefined();
  await methods.beginResourceDeletion(args.userId, {
    kind: 'file',
    resourceIds: [args.fileId],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: args.conversationId }],
  });
  const fresh = await loadSGTerminalSnapshot(args);
  expect(fresh.response.metadata?.sgArtifacts).toBeUndefined();
  expect(fresh.request.files).toEqual([]);
  expect(fresh.response.text).toBe('synthetic terminal body');
  expect(cached.response.metadata?.sgArtifacts).toBeDefined();
});

test.each(['conversation', 'request', 'response', 'owner'])(
  'terminal snapshot refuses a missing or deleted %s',
  async (missing) => {
    const args = await terminalFixture();
    if (missing === 'conversation')
      await methods.beginResourceDeletion(args.userId, {
        kind: 'conversation',
        resourceIds: [args.conversationId],
        gateways: [],
      });
    if (missing === 'request') await models.Message.deleteOne({ messageId: args.requestMessageId });
    if (missing === 'response')
      await models.Message.deleteOne({ messageId: args.responseMessageId });
    if (missing === 'owner') args.userId = other.toString();
    await expect(loadSGTerminalSnapshot(args)).rejects.toThrow('sg_terminal_snapshot_unavailable');
  },
);

test.each(['requestMessageId', 'responseMessageId'] as const)(
  'terminal and cached FINAL refuse expired %s before physical deletion',
  async (key) => {
    const args = await terminalFixture();
    const cached = await loadSGTerminalSnapshot(args);
    const event = {
      final: true as const,
      requestMessage: { messageId: args.requestMessageId },
      responseMessage: { messageId: args.responseMessageId, metadata: cached.response.metadata },
    };
    await models.Message.updateOne({ messageId: args[key] }, { expiredAt: new Date(0) });
    await expect(loadSGTerminalSnapshot(args)).rejects.toThrow('sg_terminal_snapshot_unavailable');
    await expect(refreshSGReplayFinal({ ...args, event })).rejects.toThrow(
      'sg_terminal_snapshot_unavailable',
    );
    expect(await models.Message.countDocuments({ messageId: args[key] })).toBe(1);
  },
);

test('cached FINAL refresh removes stale SG metadata without changing the cached event', async () => {
  const args = await terminalFixture();
  const cached = await loadSGTerminalSnapshot(args);
  const event = {
    final: true as const,
    requestMessage: { messageId: args.requestMessageId },
    responseMessage: { messageId: args.responseMessageId, metadata: cached.response.metadata },
  };
  await methods.beginResourceDeletion(args.userId, {
    kind: 'file',
    resourceIds: [args.fileId],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: args.conversationId }],
  });
  const refreshed = await refreshSGReplayFinal({ ...args, event });
  expect(refreshed.responseMessage?.metadata).not.toHaveProperty('sgArtifacts');
  expect(event.responseMessage.metadata).toHaveProperty('sgArtifacts');
  expect(refreshed.responseMessage?.text).toBe('synthetic terminal body');
});

test('resume and untagged final file lists remove only known deleted IDs', async () => {
  const id = uuidv4(),
    removed = uuidv4(),
    kept = uuidv4();
  await methods.beginResourceDeletion(owner.toString(), {
    kind: 'file',
    resourceIds: [removed],
    gateways: [],
  });
  const userMessage = {
    messageId: 'request',
    text: 'keep request text',
    files: [{ file_id: removed }, { file_id: kept }],
  };
  const state = { runSteps: [], userMessage };
  const filtered = await filterSGResumeFiles({ userId: owner.toString(), state, methods });
  expect(filtered.userMessage).toMatchObject({
    text: 'keep request text',
    files: [{ file_id: kept }],
  });
  expect(state.userMessage.files).toHaveLength(2);
  const event = {
    final: true as const,
    requestMessage: userMessage,
    responseMessage: { text: 'keep answer', files: userMessage.files },
  };
  const result = await refreshSGReplayFinal({
    userId: owner.toString(),
    conversationId: id,
    event,
    methods,
  });
  expect(result.responseMessage).toMatchObject({ text: 'keep answer', files: [{ file_id: kept }] });
  expect(result.requestMessage?.files).toEqual([{ file_id: kept }]);
});

test('pending steer projections retain missing-file identity without exposing cached content or changing the source', async () => {
  const removed = uuidv4(),
    kept = uuidv4(),
    conversationId = uuidv4();
  await methods.beginResourceDeletion(owner.toString(), {
    kind: 'file',
    resourceIds: [removed],
    gateways: [],
  });
  const steers = [
    {
      steerId: 'steer-one',
      clientSteerId: 'client-one',
      text: 'analyze the attached source',
      preempt: true,
      preemptRevision: 2,
      files: [
        {
          file_id: removed,
          filename: 'private-name.pdf',
          filepath: '/private-path',
          text: 'private cached content',
        },
        { file_id: kept, filename: 'kept.pdf' },
      ],
    },
  ];
  const expected = {
    ...steers[0],
    files: [
      { file_id: removed, status: 'failed' },
      { file_id: kept, filename: 'kept.pdf' },
    ],
  };
  expect(await filterSGPendingSteerFiles({ userId: owner.toString(), steers, methods })).toEqual([
    expected,
  ]);
  expect(() =>
    sg.buildSGInternalContext({
      userId: owner.toString(),
      conversationId,
      messageId: uuidv4(),
      endpoint: 'SG AI Gateway',
      requestFiles: [expected.files[0]],
      authorizedFiles: [],
    }),
  ).toThrow('sg_file_reference_not_found');
  const state = await filterSGResumeFiles({
    userId: owner.toString(),
    state: { runSteps: [], pendingSteers: steers },
    methods,
  });
  expect(state.pendingSteers).toEqual([expected]);
  expect(state.userMessage).toBeUndefined();
  const event = { final: true as const, pendingSteers: steers };
  expect(needsSGReplayRefresh(event)).toBe(true);
  expect(
    (await refreshSGReplayFinal({ userId: owner.toString(), conversationId, event, methods }))
      .pendingSteers,
  ).toEqual([expected]);
  expect(steers[0].files[0]).toHaveProperty('text', 'private cached content');
  expect(await filterSGPendingSteerFiles({ userId: other.toString(), steers, methods })).toBe(
    steers,
  );
});

test.each(['expiredAt', 'sgUploadExpiresAt'] as const)(
  'expired SG files use %s and journal the cascade',
  async (deadlineField) => {
    let root!: Awaited<ReturnType<typeof file>>;
    let child!: Awaited<ReturnType<typeof file>>;
    await tenantStorage.run({ tenantId: 'tenant-expiry', userId: owner.toString() }, async () => {
      root = await file(uuidv4());
      child = await file(root.conversationId!);
      await models.File.updateOne({ file_id: root.file_id }, { [deadlineField]: new Date(0) });
    });
    jest.spyOn(sg, 'deleteSGGatewayScopedFileTree').mockResolvedValue({
      schema_version: 1,
      file_id: root.file_id,
      conversation_id: root.conversationId!,
      deleted_file_ids: [root.file_id, child.file_id],
      request_message_ids: [],
    });
    const loadConfig = jest.fn(async (tenantId?: string) => {
      expect(tenantId).toBe('tenant-expiry');
      expect(tenantStorage.getStore()).toEqual({ tenantId, userId: owner.toString() });
      return appConfig;
    });
    const result = await runAsSystem(async () =>
      deleteExpiredSGFile({ file: root, methods, loadConfig }),
    );
    expect(result).toEqual({ retained: false, fileIds: [root.file_id, child.file_id] });
    await tenantStorage.run({ tenantId: 'tenant-expiry' }, async () => {
      expect(await models.File.countDocuments()).toBe(0);
      expect(
        (await methods.findResourceDeletion(owner.toString(), 'file', [root.file_id]))?.state,
      ).toBe('complete');
    });
  },
);

test('expiry rechecks a renewed deadline without creating a deletion intent', async () => {
  const root = await file(uuidv4());
  await models.File.updateOne(
    { file_id: root.file_id },
    { expiredAt: new Date(Date.now() + 60_000) },
  );
  const loadConfig = jest.fn(async () => appConfig);
  expect(await deleteExpiredSGFile({ file: root, methods, loadConfig })).toEqual({
    retained: true,
    fileIds: [],
  });
  expect(loadConfig).not.toHaveBeenCalled();
  expect(await models.ResourceDeletion.countDocuments()).toBe(0);
  expect(await models.File.findOne({ file_id: root.file_id })).not.toBeNull();
});

test.each(['expiredAt', 'sgUploadExpiresAt'] as const)(
  'failed %s cleanup retains its local row and pending journal for retry',
  async (deadlineField) => {
    const root = await file(uuidv4());
    await models.File.updateOne({ file_id: root.file_id }, { [deadlineField]: new Date(0) });
    jest
      .spyOn(sg, 'deleteSGGatewayScopedFileTree')
      .mockRejectedValue(new sg.SGFileGatewayError(503, 'synthetic_gateway_unavailable'));
    await expect(
      deleteExpiredSGFile({ file: root, methods, loadConfig: async () => appConfig }),
    ).rejects.toThrow('synthetic_gateway_unavailable');
    expect(await models.File.findOne({ file_id: root.file_id })).not.toBeNull();
    expect(
      (await methods.findResourceDeletion(owner.toString(), 'file', [root.file_id]))?.state,
    ).toBe('pending');
  },
);
