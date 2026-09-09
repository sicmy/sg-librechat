import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources } from 'librechat-data-provider';
import { createMethods } from './index';
import { createModels } from '~/models';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';

let afterDeletionLookup: (() => Promise<void>) | undefined;
mongoose.plugin((schema) => {
  if (schema.get('collection') !== 'resource_deletions') return;
  schema.post('find', async () => {
    const action = afterDeletionLookup;
    afterDeletionLookup = undefined;
    await action?.();
  });
});
const models = createModels(mongoose);
const methods = createMethods(mongoose);
const owner = new mongoose.Types.ObjectId();
let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(Object.values(models).map((model) => model.init()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all([
      models.ResourceDeletion.deleteMany({}),
      models.Message.deleteMany({}),
      models.Conversation.deleteMany({}),
      models.File.deleteMany({}),
    ]);
  });
});
afterEach(() => {
  afterDeletionLookup = undefined;
  jest.restoreAllMocks();
});

function fixture() {
  const conversationId = uuidv4(),
    fileId = uuidv4(),
    messageId = uuidv4();
  return {
    conversationId,
    fileId,
    messageId,
    write: {
      record: () =>
        methods.recordMessage({
          user: owner.toString(),
          conversationId,
          messageId,
          text: 'synthetic late direct record',
        }),
      message: () =>
        methods.saveMessage(
          { userId: owner.toString() },
          {
            conversationId,
            messageId,
            text: 'synthetic late message',
            isCreatedByUser: false,
          },
        ),
      conversation: () =>
        methods.saveConvo(
          { userId: owner.toString() },
          {
            conversationId,
            endpoint: 'SG AI Gateway',
            title: 'synthetic late title',
          },
        ),
      file: () =>
        methods.createFile({
          user: owner,
          conversationId,
          file_id: fileId,
          filename: 'synthetic.png',
          filepath: '/synthetic.png',
          bytes: 1,
          type: 'image/png',
          source: FileSources.sg_gateway,
        }),
    },
  };
}
async function close(conversationId: string, complete = false) {
  const job = await methods.beginResourceDeletion(owner.toString(), {
    kind: 'conversation',
    resourceIds: [conversationId],
    gateways: [],
  });
  if (complete) {
    const lease = await methods.claimResourceDeletion(owner.toString(), job._id);
    await methods.recordResourceDeletionTargets(
      owner.toString(),
      job._id,
      lease!.leaseToken!,
      [],
      [],
    );
    await methods.finishResourceDeletion(owner.toString(), job._id, lease!.leaseToken!);
  }
  return job;
}
const writers = ['message', 'conversation', 'file', 'record'] as const;
test.each(writers)(
  '%s writes are blocked by pending and completed conversation deletion',
  async (kind) => {
    for (const complete of [false, true]) {
      const data = fixture();
      await close(data.conversationId, complete);
      await expect(data.write[kind]()).rejects.toThrow('resource_deleted');
    }
    expect(await models.Message.countDocuments()).toBe(0);
    expect(await models.Conversation.countDocuments()).toBe(0);
    expect(await models.File.countDocuments()).toBe(0);
  },
);

test.each(writers)(
  '%s compensates a deletion committed between its precheck and persistence',
  async (kind) => {
    const data = fixture();
    const original = models.ResourceDeletion.exists.bind(models.ResourceDeletion);
    jest.spyOn(models.ResourceDeletion, 'exists').mockImplementationOnce((filter) => {
      const query = original(filter);
      const exec = query.exec.bind(query);
      jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
        const before = await exec();
        expect(before).toBeNull();
        await close(data.conversationId, true);
        return before;
      });
      return query;
    });
    await expect(data.write[kind]()).rejects.toThrow('resource_deleted');
    expect(await models.Message.countDocuments()).toBe(0);
    expect(await models.Conversation.countDocuments()).toBe(0);
    expect(await models.File.countDocuments()).toBe(0);
  },
);

test('file tombstones block a file ID without closing unrelated files in the same conversation', async () => {
  const removed = fixture();
  await methods.beginResourceDeletion(owner.toString(), {
    kind: 'file',
    resourceIds: [removed.fileId],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: removed.conversationId }],
  });
  await expect(removed.write.file()).rejects.toThrow('resource_deleted');
  await expect(removed.write.message()).resolves.toBeDefined();
  await expect(
    methods.createFile({
      user: owner,
      conversationId: removed.conversationId,
      file_id: uuidv4(),
      filename: 'kept.png',
      filepath: '/kept.png',
      bytes: 1,
      type: 'image/png',
    }),
  ).resolves.toBeDefined();
});

test('another tenant can still save the same logical conversation and ordinary new work remains allowed', async () => {
  const removed = fixture(),
    fresh = fixture();
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => close(removed.conversationId));
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    await expect(removed.write.message()).resolves.toBeDefined();
    await expect(removed.write.conversation()).resolves.toBeDefined();
    await expect(removed.write.file()).resolves.toBeDefined();
  });
  await expect(fresh.write.message()).resolves.toBeDefined();
  await expect(fresh.write.conversation()).resolves.toBeDefined();
  await expect(fresh.write.file()).resolves.toBeDefined();
});

test.each(['source', 'request'])(
  'late derived file registration follows the deleted %s lineage',
  async (kind) => {
    const data = fixture(),
      requestMessageId = uuidv4();
    const job = await methods.beginResourceDeletion(owner.toString(), {
      kind: 'file',
      resourceIds: [data.fileId],
      gateways: [{ endpoint: 'SG AI Gateway', conversationId: data.conversationId }],
    });
    const lease = await methods.claimResourceDeletion(owner.toString(), job._id);
    await methods.recordResourceDeletionTargets(
      owner.toString(),
      job._id,
      lease!.leaseToken!,
      [data.fileId],
      [requestMessageId],
    );
    await expect(
      methods.createFile({
        user: owner,
        file_id: uuidv4(),
        conversationId: data.conversationId,
        filename: 'late.png',
        filepath: '/late.png',
        type: 'image/png',
        bytes: 1,
        metadata: {
          sgGateway: {
            endpoint: 'SG AI Gateway',
            conversationId: data.conversationId,
            jobId: 'job_late',
            state: 'READY',
            ...(kind === 'source' ? { sourceFileId: data.fileId } : { requestMessageId }),
          },
        },
      }),
    ).rejects.toThrow('resource_deleted');
    expect(await models.File.countDocuments()).toBe(0);
  },
);

const patches = ['text', 'fields', 'tool'] as const;
function patch(data: ReturnType<typeof fixture>, kind: (typeof patches)[number]) {
  if (kind === 'text')
    return methods.updateMessageText(owner.toString(), {
      messageId: data.messageId,
      text: 'late patch',
    });
  if (kind === 'fields')
    return methods.updateMessage(owner.toString(), {
      messageId: data.messageId,
      text: 'late patch',
    });
  return methods.updateToolCallResult({
    userId: owner.toString(),
    messageId: data.messageId,
    conversationId: data.conversationId,
    toolCallId: 'late_tool',
    output: 'late output',
    attachments: [{ file_id: 'file_late_tool' }],
  });
}

test.each(patches)(
  '%s patch refuses pending and completed deletion using the stored conversation',
  async (kind) => {
    for (const complete of [false, true]) {
      const data = fixture();
      await data.write.message();
      await close(data.conversationId, complete);
      await expect(patch(data, kind)).rejects.toThrow('resource_deleted');
      expect((await models.Message.findOne({ messageId: data.messageId }))?.text).toBe(
        'synthetic late message',
      );
    }
  },
);

test.each(patches)(
  '%s patch compensates deletion crossing its precheck and leaves unrelated messages intact',
  async (kind) => {
    const data = fixture(),
      kept = fixture();
    await data.write.message();
    await kept.write.message();
    const exists = models.ResourceDeletion.exists.bind(models.ResourceDeletion);
    jest.spyOn(models.ResourceDeletion, 'exists').mockImplementationOnce((filter) => {
      const query = exists(filter);
      const exec = query.exec.bind(query);
      jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
        const before = await exec();
        await close(data.conversationId, true);
        return before;
      });
      return query;
    });
    await expect(patch(data, kind)).rejects.toThrow('resource_deleted');
    expect(await models.Message.findOne({ messageId: data.messageId })).toBeNull();
    expect(await models.Message.findOne({ messageId: kept.messageId })).not.toBeNull();
  },
);

test('partial updates keep ownership fixed and cannot move a live message into a deleted conversation', async () => {
  const data = fixture(),
    deleted = fixture();
  await data.write.message();
  await methods.updateMessage(owner.toString(), {
    messageId: data.messageId,
    user: new mongoose.Types.ObjectId().toString(),
    text: 'owned update',
  });
  expect((await models.Message.findOne({ messageId: data.messageId }))?.user).toBe(
    owner.toString(),
  );
  await close(deleted.conversationId, true);
  await expect(
    methods.updateMessage(owner.toString(), {
      messageId: data.messageId,
      conversationId: deleted.conversationId,
    }),
  ).rejects.toThrow('resource_deleted');
  expect((await models.Message.findOne({ messageId: data.messageId }))?.conversationId).toBe(
    data.conversationId,
  );
});

const bulkKinds = ['messages', 'conversations'] as const;
function bulk(
  kind: (typeof bulkKinds)[number],
  rows: ReturnType<typeof fixture>[],
  user = owner.toString(),
) {
  if (kind === 'messages')
    return methods.bulkSaveMessages(
      rows.map((row) => ({
        user,
        conversationId: row.conversationId,
        messageId: row.messageId,
        text: 'synthetic bulk',
        isCreatedByUser: true,
      })),
    );
  return methods.bulkSaveConvos(
    rows.map((row) => ({
      user,
      conversationId: row.conversationId,
      title: 'synthetic bulk',
      endpoint: 'SG AI Gateway',
    })),
  );
}
test.each(bulkKinds)('bulk %s reject deleted scopes before writing any row', async (kind) => {
  for (const complete of [false, true]) {
    const deleted = fixture(),
      fresh = fixture();
    await close(deleted.conversationId, complete);
    await expect(bulk(kind, [deleted, fresh])).rejects.toThrow('resource_deleted');
  }
  expect(await models.Message.countDocuments()).toBe(0);
  expect(await models.Conversation.countDocuments()).toBe(0);
});

test.each(bulkKinds)(
  'bulk %s compensate only deleted rows when deletion crosses the precheck',
  async (kind) => {
    const deleted = fixture(),
      kept = fixture();
    afterDeletionLookup = async () => {
      await close(deleted.conversationId, true);
    };
    await expect(bulk(kind, [deleted, kept])).rejects.toThrow('resource_deleted');
    const model = kind === 'messages' ? models.Message : models.Conversation;
    expect(await model.countDocuments({ conversationId: deleted.conversationId })).toBe(0);
    expect(await model.countDocuments({ conversationId: kept.conversationId })).toBe(1);
  },
);

test.each(bulkKinds)('bulk %s require scoped owners and preserve another tenant', async (kind) => {
  const data = fixture();
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => close(data.conversationId, true));
  await tenantStorage.run({ tenantId: 'tenant-b', userId: owner.toString() }, async () => {
    await expect(bulk(kind, [data])).resolves.toBeDefined();
    await expect(bulk(kind, [fixture()], 'forged-owner')).rejects.toThrow();
  });
  await expect(runAsSystem(async () => bulk(kind, [fixture()]))).rejects.toThrow();
  const model = kind === 'messages' ? models.Message : models.Conversation;
  expect(await runAsSystem(async () => model.countDocuments({ tenantId: 'tenant-b' }))).toBe(1);
});

test('bulk message IDs cannot transfer another owner message', async () => {
  const data = fixture();
  await data.write.message();
  const other = new mongoose.Types.ObjectId().toString();
  await expect(bulk('messages', [data], other)).resolves.toBeDefined();
  expect(
    (await models.Message.findOne({ messageId: data.messageId, user: owner.toString() }))?.text,
  ).toBe('synthetic late message');
  expect((await models.Message.findOne({ messageId: data.messageId, user: other }))?.text).toBe(
    'synthetic bulk',
  );
  await expect(
    methods.bulkSaveMessages([{ messageId: uuidv4(), text: 'missing scope' }]),
  ).rejects.toThrow('resource_batch_scope_required');
});

test('a write error after bulk persistence still compensates a racing deletion', async () => {
  const deleted = fixture(),
    kept = fixture();
  const write = models.Message.bulkWrite.bind(models.Message);
  jest.spyOn(models.Message, 'bulkWrite').mockImplementationOnce(async (operations) => {
    await write(operations);
    await close(deleted.conversationId, true);
    throw new Error('synthetic_lost_bulk_acknowledgement');
  });
  await expect(bulk('messages', [deleted, kept])).rejects.toThrow('resource_deleted');
  expect(await models.Message.countDocuments({ conversationId: deleted.conversationId })).toBe(0);
  expect(await models.Message.countDocuments({ conversationId: kept.conversationId })).toBe(1);
});
