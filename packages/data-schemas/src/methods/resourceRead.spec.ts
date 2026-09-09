import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources } from 'librechat-data-provider';
import { createModels } from '~/models';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createMethods } from './index';

const models = createModels(mongoose);
const methods = createMethods(mongoose);
test('SG uploads migrate away from TTL without changing other sources or their effective deadline', async () => {
  const sg = await fixture();
  const local = await fixture();
  const deadline = new Date('2100-01-01');
  await models.File.updateOne({ file_id: sg.fileId }, { expiresAt: deadline });
  await models.File.updateOne(
    { file_id: local.fileId },
    { source: FileSources.local, expiresAt: deadline },
  );
  await expect(methods.prepareSGUploadExpiry()).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await methods.prepareSGUploadExpiry();
    await methods.prepareSGUploadExpiry();
  });
  const migrated = await models.File.findOne({ file_id: sg.fileId }).lean();
  expect(migrated?.expiresAt).toBeUndefined();
  expect(migrated?.sgUploadExpiresAt).toEqual(deadline);
  expect((await models.File.findOne({ file_id: local.fileId }).lean())?.expiresAt).toEqual(
    deadline,
  );
  expect(
    (await models.File.collection.indexes()).find((index) => index.key.sgUploadExpiresAt === 1)
      ?.expireAfterSeconds,
  ).toBeUndefined();
});

test('new SG uploads use application expiry, can be held and become permanent only when used', async () => {
  const data = await fixture();
  const upload = await methods.createFile({
    user: owner,
    file_id: uuidv4(),
    conversationId: data.conversationId,
    source: FileSources.sg_gateway,
    filename: 'synthetic.txt',
    filepath: '/synthetic.txt',
    type: 'text/plain',
    bytes: 1,
  });
  expect(upload?.expiresAt).toBeUndefined();
  expect(upload?.sgUploadExpiresAt).toBeInstanceOf(Date);
  await methods.updateFile({ file_id: upload!.file_id, status: 'ready' });
  expect(
    (await models.File.findOne({ file_id: upload!.file_id }).lean())?.sgUploadExpiresAt,
  ).toEqual(upload?.sgUploadExpiresAt);
  expect(
    await methods.extendFilesTTL(
      [upload!.file_id],
      { renewMs: 24 * 3600_000, maxLifetimeMs: 48 * 3600_000 },
      { user: owner.toString() },
    ),
  ).toBe(1);
  const held = await models.File.findOne({ file_id: upload!.file_id }).lean();
  expect(held!.sgUploadExpiresAt!.getTime()).toBeGreaterThan(upload!.sgUploadExpiresAt!.getTime());
  await methods.updateFileUsage({
    file_id: upload!.file_id,
    user: new mongoose.Types.ObjectId().toString(),
  });
  expect(
    (await models.File.findOne({ file_id: upload!.file_id }).lean())?.sgUploadExpiresAt,
  ).toEqual(held?.sgUploadExpiresAt);
  await methods.updateFileUsage({ file_id: upload!.file_id, user: owner.toString() });
  expect(
    (await models.File.findOne({ file_id: upload!.file_id }).lean())?.sgUploadExpiresAt,
  ).toBeUndefined();
  expect(
    await methods.extendFilesTTL(
      [upload!.file_id],
      { renewMs: 24 * 3600_000, maxLifetimeMs: 48 * 3600_000 },
      { user: owner.toString() },
    ),
  ).toBe(0);
});

test('abandoned SG upload access and cleanup respect the original one-hour TTL grace', async () => {
  const data = await fixture();
  const now = new Date();
  const base = new Date(now.getTime() - 3600_000);
  await models.File.updateOne({ file_id: data.fileId }, { sgUploadExpiresAt: base });
  expect(
    (await methods.getExpiredFiles(100, new Date(now.getTime() - 1))).map((file) => file.file_id),
  ).not.toContain(data.fileId);
  expect((await methods.getExpiredFiles(100, now)).map((file) => file.file_id)).toContain(
    data.fileId,
  );
  expect(await methods.findFileById(data.fileId)).toBeNull();
  expect(await models.File.countDocuments({ file_id: data.fileId })).toBe(1);
});
test('conversation expiry migration replaces only the TTL index and is idempotent', async () => {
  const collection = models.Conversation.collection;
  await collection.dropIndex('expiredAt_1');
  await collection.createIndex({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  const data = await fixture();
  await expect(methods.prepareConversationExpiryIndex()).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await methods.prepareConversationExpiryIndex();
    await methods.prepareConversationExpiryIndex();
  });
  const indexes = await collection.indexes();
  expect(indexes.find((index) => index.name === 'expiredAt_1')?.expireAfterSeconds).toBeUndefined();
  expect(indexes.some((index) => index.key.conversationId === 1)).toBe(true);
  expect(await models.Conversation.countDocuments({ conversationId: data.conversationId })).toBe(1);
});

test('expiry discovery requires system scope, validates bounds and selects only expired rows', async () => {
  const expired = await fixture();
  const future = await fixture();
  await models.Conversation.updateOne(
    { conversationId: expired.conversationId },
    { expiredAt: new Date(0) },
  );
  await models.Conversation.updateOne(
    { conversationId: future.conversationId },
    { expiredAt: new Date('2100-01-01') },
  );
  await expect(methods.getExpiredConversations()).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await expect(methods.getExpiredConversations(0)).rejects.toThrow(
      'invalid_conversation_expiry_scan',
    );
    await expect(methods.getExpiredConversations(1, new Date('invalid'))).rejects.toThrow(
      'invalid_conversation_expiry_scan',
    );
    const rows = await methods.getExpiredConversations(1);
    expect(rows.map((row) => row.conversationId)).toEqual([expired.conversationId]);
  });
});
const owner = new mongoose.Types.ObjectId();
let server: MongoMemoryServer;
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
  await runAsSystem(async () => {
    await Promise.all([
      models.Conversation.deleteMany({}),
      models.Message.deleteMany({}),
      models.File.deleteMany({}),
      models.ResourceDeletion.deleteMany({}),
    ]);
  });
});
async function fixture(title = 'synthetic', conversationId = uuidv4(), user = owner) {
  const messageId = uuidv4(),
    fileId = uuidv4();
  await models.Conversation.create({
    conversationId,
    user: user.toString(),
    title,
    endpoint: 'SG AI Gateway',
  });
  await models.Message.create({
    conversationId,
    user: user.toString(),
    messageId,
    text: 'synthetic',
    isCreatedByUser: true,
    _meiliIndex: true,
  });
  await models.File.create({
    conversationId,
    user,
    file_id: fileId,
    source: FileSources.sg_gateway,
    filename: 'synthetic.png',
    filepath: '/synthetic.png',
    bytes: 1,
    type: 'image/png',
  });
  return { conversationId, messageId, fileId };
}
async function tombstone(conversationId: string, complete = false) {
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
}
test.each([false, true])(
  'conversation tombstones hide persisted rows (complete=%s), while internal cleanup still selects them',
  async (complete) => {
    const data = await fixture();
    await tombstone(data.conversationId, complete);
    expect(await models.Conversation.countDocuments()).toBe(1);
    expect(await methods.getConvo(owner.toString(), data.conversationId)).toBeNull();
    expect(
      await methods.getMessage({ user: owner.toString(), messageId: data.messageId }),
    ).toBeNull();
    expect((await methods.getMessagesByCursor({ user: owner.toString() })).messages).toEqual([]);
    expect(await methods.getMessages({ user: owner.toString() }, 'text')).toEqual([]);
    expect(
      await methods.getMessages({ user: owner.toString() }, 'text', { includeDeleted: true }),
    ).toHaveLength(1);
    expect((await methods.getConvosByCursor(owner.toString())).conversations).toEqual([]);
    expect((await methods.getConvosQueried(owner.toString(), [data])).conversations).toEqual([]);
    expect(await methods.getFiles({ user: owner })).toEqual([]);
    expect(await methods.findFileById(data.fileId)).toBeNull();
    expect(await methods.getConversationsForDeletion(owner.toString())).toEqual([
      data.conversationId,
    ]);
    expect(
      await methods.getFiles({ user: owner }, undefined, undefined, { includeDeleted: true }),
    ).toHaveLength(1);
  },
);
test('conversation pagination fills visible pages and derives its cursor only from visible rows', async () => {
  const a = await fixture('a'),
    b = await fixture('b'),
    c = await fixture('c'),
    d = await fixture('d'),
    e = await fixture('e');
  await tombstone(a.conversationId);
  await tombstone(c.conversationId, true);
  const first = await methods.getConvosByCursor(owner.toString(), {
    limit: 2,
    sortBy: 'title',
    sortDirection: 'asc',
  });
  expect(first.conversations.map((row) => row.conversationId)).toEqual([
    b.conversationId,
    d.conversationId,
  ]);
  expect(first.nextCursor).not.toBeNull();
  const last = await methods.getConvosByCursor(owner.toString(), {
    limit: 2,
    sortBy: 'title',
    sortDirection: 'asc',
    cursor: first.nextCursor,
  });
  expect(last.conversations.map((row) => row.conversationId)).toEqual([e.conversationId]);
  expect(last.nextCursor).toBeNull();
});
test('file-only deletion hides its own file but leaves the conversation, message and unrelated files visible', async () => {
  const data = await fixture();
  const keptId = uuidv4();
  await models.File.create({
    user: owner,
    file_id: keptId,
    conversationId: data.conversationId,
    filename: 'kept.png',
    filepath: '/kept.png',
    bytes: 1,
    type: 'image/png',
  });
  await methods.beginResourceDeletion(owner.toString(), {
    kind: 'file',
    resourceIds: [data.fileId],
    gateways: [],
  });
  expect(await methods.findFileById(data.fileId)).toBeNull();
  expect((await methods.getFiles({ user: owner }))?.map((file) => file.file_id)).toEqual([keptId]);
  expect(await methods.getConvo(owner.toString(), data.conversationId)).not.toBeNull();
  const message = await methods.getMessage({ user: owner.toString(), messageId: data.messageId });
  expect(message).not.toBeNull();
  expect(message).not.toHaveProperty('_meiliIndex');
});
test('lookup matches tenant and owner, not just a reused conversation ID', async () => {
  const id = uuidv4(),
    other = new mongoose.Types.ObjectId();
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    await fixture('deleted', id);
    await fixture('other owner', id, other);
    await tombstone(id);
    expect(await methods.getConvo(owner.toString(), id)).toBeNull();
    expect(await methods.getConvo(other.toString(), id)).not.toBeNull();
    expect(await methods.getFiles({ user: other })).toHaveLength(1);
  });
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    await fixture('other tenant', id);
    expect(await methods.getConvo(owner.toString(), id)).not.toBeNull();
    expect(await methods.getFiles({ user: owner })).toHaveLength(1);
  });
});
test('raw late insertion after completed deletion is still invisible without relying on the writer compensation', async () => {
  const id = uuidv4();
  await tombstone(id, true);
  const late = await fixture('late after crash', id);
  expect(await models.File.countDocuments()).toBe(1);
  expect(await methods.getConvo(owner.toString(), id)).toBeNull();
  expect(
    await methods.getMessage({ user: owner.toString(), messageId: late.messageId }),
  ).toBeNull();
  expect(await methods.findFileById(late.fileId)).toBeNull();
});

test.each([false, true])(
  'file reference redaction preserves body and unrelated metadata (complete=%s)',
  async (complete) => {
    const data = await fixture();
    const artifact = (id: string, source?: string) => ({
      file_id: id,
      ...(source ? { source_file_id: source } : {}),
      conversation_id: data.conversationId,
    });
    const metadata = {
      keep: null,
      sgArtifacts: {
        schema_version: 1,
        artifacts: [artifact('file_child', data.fileId), artifact('file_kept')],
      },
      sgCitations: {
        schema_version: 1,
        citations: [
          { file_id: data.fileId, quote: 'removed root quote' },
          { file_id: 'file_child', quote: 'removed child quote' },
          { file_id: 'file_kept', quote: 'kept quote' },
        ],
      },
      sgGeneration: { requestMessageId: uuidv4(), state: 'delivered' },
    };
    await models.Message.updateOne(
      { messageId: data.messageId },
      {
        text: 'keep conversation body',
        metadata,
        files: [{ file_id: data.fileId }, { file_id: 'file_child' }, { file_id: 'file_kept' }],
      },
    );
    const job = await methods.beginResourceDeletion(owner.toString(), {
      kind: 'file',
      resourceIds: [data.fileId],
      gateways: [{ endpoint: 'SG AI Gateway', conversationId: data.conversationId }],
    });
    if (complete) {
      const lease = await methods.claimResourceDeletion(owner.toString(), job._id);
      await methods.recordResourceDeletionTargets(
        owner.toString(),
        job._id,
        lease!.leaseToken!,
        [data.fileId],
        [],
      );
      await methods.finishResourceDeletion(owner.toString(), job._id, lease!.leaseToken!);
    }
    const expected = {
      text: 'keep conversation body',
      files: [{ file_id: 'file_kept' }],
      metadata: {
        keep: null,
        sgArtifacts: { artifacts: [artifact('file_kept')] },
        sgCitations: { citations: [{ file_id: 'file_kept', quote: 'kept quote' }] },
        sgGeneration: { state: 'cancelled' },
      },
    };
    expect(
      await methods.getMessage({ user: owner.toString(), messageId: data.messageId }),
    ).toMatchObject(expected);
    expect((await methods.getMessages({ user: owner.toString() }))[0]).toMatchObject(expected);
    expect(
      (await methods.getMessagesByCursor({ user: owner.toString() })).messages[0],
    ).toMatchObject(expected);
    expect((await models.Message.findOne({ messageId: data.messageId }))?.metadata).toMatchObject(
      metadata,
    );
    expect(
      (await methods.getMessages({ user: owner.toString() }, 'metadata'))[0].metadata,
    ).toMatchObject(expected.metadata);
    const saved = await methods.saveMessage(
      { userId: owner.toString() },
      {
        conversationId: data.conversationId,
        messageId: data.messageId,
        text: 'keep conversation body',
        metadata,
      },
    );
    expect(saved).toMatchObject(expected);
  },
);

test('a deleted generation request hides unknown late output references and file rows', async () => {
  const data = await fixture(),
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
  await models.Message.updateOne(
    { messageId: data.messageId },
    {
      metadata: {
        sgArtifacts: {
          artifacts: [{ file_id: 'file_unreported', conversation_id: data.conversationId }],
        },
        sgGeneration: { requestMessageId, state: 'pending' },
      },
      files: [{ file_id: 'file_unreported' }],
    },
  );
  await models.File.create({
    user: owner,
    conversationId: data.conversationId,
    file_id: 'file_unreported',
    filename: 'late.png',
    filepath: '/late.png',
    bytes: 1,
    type: 'image/png',
    metadata: {
      sgGateway: {
        endpoint: 'SG AI Gateway',
        conversationId: data.conversationId,
        jobId: 'job_late',
        state: 'READY',
        requestMessageId,
      },
    },
  });
  const visible = await methods.getMessage({ user: owner.toString(), messageId: data.messageId });
  expect(visible?.metadata?.sgArtifacts).toBeUndefined();
  expect(visible?.metadata?.sgGeneration).toMatchObject({ state: 'cancelled' });
  expect(visible?.files).toEqual([]);
  expect(await methods.findFileById('file_unreported')).toBeNull();
});

test('reference redaction never borrows a tombstone from another owner or tenant', async () => {
  const conversationId = uuidv4(),
    fileId = uuidv4(),
    other = new mongoose.Types.ObjectId();
  const metadata = {
    sgCitations: { citations: [{ file_id: fileId, quote: 'kept in another scope' }] },
  };
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    await methods.beginResourceDeletion(owner.toString(), {
      kind: 'file',
      resourceIds: [fileId],
      gateways: [],
    });
    const messageId = uuidv4();
    await models.Message.create({
      user: other.toString(),
      conversationId,
      messageId,
      isCreatedByUser: true,
      metadata,
    });
    expect((await methods.getMessage({ user: other.toString(), messageId }))?.metadata).toEqual(
      metadata,
    );
  });
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    const messageId = uuidv4();
    await models.Message.create({
      user: owner.toString(),
      conversationId,
      messageId,
      isCreatedByUser: true,
      metadata,
    });
    expect((await methods.getMessage({ user: owner.toString(), messageId }))?.metadata).toEqual(
      metadata,
    );
  });
});

test('expired messages are hidden before TTL deletion while cleanup retains their file references', async () => {
  const data = await fixture();
  await models.Message.updateOne(
    { messageId: data.messageId },
    {
      expiredAt: new Date(0),
      files: [{ file_id: data.fileId }],
      metadata: {
        sgCitations: { citations: [{ file_id: data.fileId, quote: 'expired synthetic quote' }] },
      },
    },
  );
  const filter = { user: owner.toString(), conversationId: data.conversationId };
  expect(await models.Message.countDocuments(filter)).toBe(1);
  expect(
    await methods.getMessage({ user: owner.toString(), messageId: data.messageId }),
  ).toBeNull();
  expect(await methods.getMessages(filter)).toEqual([]);
  expect((await methods.getMessagesByCursor(filter)).messages).toEqual([]);
  const [internal] = await methods.getMessages(filter, 'files metadata', { includeDeleted: true });
  expect(internal.files).toEqual([expect.objectContaining({ file_id: data.fileId })]);
  expect(internal.metadata?.sgCitations).toBeDefined();
  await models.Message.updateOne(
    { messageId: data.messageId },
    { expiredAt: new Date(Date.now() + 60_000) },
  );
  expect(
    await methods.getMessage({ user: owner.toString(), messageId: data.messageId }),
  ).not.toBeNull();
});

test('message expiry filtering fills limited pages without leaking an expired cursor', async () => {
  const expired = await fixture();
  const live = await fixture();
  await models.Message.updateOne(
    { messageId: expired.messageId },
    { expiredAt: new Date(0), createdAt: new Date('2020-01-01') },
  );
  await models.Message.updateOne(
    { messageId: live.messageId },
    { expiredAt: null, createdAt: new Date('2021-01-01') },
  );
  const filter = { user: owner.toString() };
  expect(
    (await methods.getMessages(filter, 'messageId', { limit: 1 })).map(
      (message) => message.messageId,
    ),
  ).toEqual([live.messageId]);
  const page = await methods.getMessagesByCursor(filter, { limit: 1, sortOrder: 1 });
  expect(page.messages.map((message) => message.messageId)).toEqual([live.messageId]);
  expect(page.nextCursor).toBeNull();
});

test('expired SG files are hidden before physical cleanup while maintenance can still select them', async () => {
  const data = await fixture();
  await models.File.updateOne({ file_id: data.fileId }, { expiredAt: new Date(0) });
  expect(await models.ResourceDeletion.countDocuments()).toBe(0);
  expect(await models.File.countDocuments()).toBe(1);
  expect(await methods.findFileById(data.fileId)).toBeNull();
  expect(await methods.getFiles({ user: owner })).toEqual([]);
  expect(
    await methods.getFiles({ user: owner }, undefined, undefined, { includeDeleted: true }),
  ).toHaveLength(1);
  expect(await methods.getExpiredFiles()).toHaveLength(1);
  await models.File.updateOne(
    { file_id: data.fileId },
    { expiredAt: new Date(Date.now() + 60_000) },
  );
  expect(await methods.findFileById(data.fileId)).not.toBeNull();
});

test('an explicit empty file projection keeps the normal all-fields query semantics', async () => {
  const data = await fixture();
  await models.File.updateOne({ file_id: data.fileId }, { text: 'synthetic source text' });
  const files = await methods.getFiles({ user: owner }, null, {});
  expect(files).toHaveLength(1);
  expect(files![0].text).toBe('synthetic source text');
  expect(files).toEqual(await models.File.find({ user: owner }).lean());
});
