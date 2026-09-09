import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createMethods } from './index';

let beforeReplace: (() => Promise<void>) | undefined;
mongoose.plugin((schema) => {
  schema.pre('replaceOne', async function () {
    const callback = beforeReplace;
    beforeReplace = undefined;
    await callback?.();
  });
});
const models = createModels(mongoose);
const methods = createMethods(mongoose);
let server: MongoMemoryServer;
const owner = new mongoose.Types.ObjectId().toString();
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
  beforeReplace = undefined;
  await runAsSystem(async () => models.Message.deleteMany({}));
  await runAsSystem(async () => models.Conversation.deleteMany({}));
});

async function fixture(expiredAt = new Date(0)) {
  return models.Message.create({
    user: owner,
    conversationId: uuidv4(),
    messageId: uuidv4(),
    isCreatedByUser: true,
    expiredAt,
    text: 'private body',
    summary: 'private summary',
    files: [{ file_id: 'file_input', filename: 'private filename' }],
    content: [{ type: 'text', text: 'private content' }],
    metadata: {
      sgArtifacts: {
        artifacts: [
          {
            file_id: 'file_output',
            source_file_id: 'file_input',
            display_name: 'private output name',
          },
        ],
      },
      sgCitations: { citations: [{ file_id: 'file_cited', quote: 'private quote' }] },
    },
  });
}

test('expired content is replaced by identity and deduplicated file IDs; live content is preserved', async () => {
  const expired = await fixture();
  const future = await fixture(new Date('2100-01-01'));
  const result = await runAsSystem(async () => methods.compactExpiredMessages());
  expect(result).toEqual({ scanned: 1, compacted: 1, retained: 0 });
  const stored = await models.Message.findById(expired._id).lean();
  expect(stored).toMatchObject({
    user: owner,
    conversationId: expired.conversationId,
    expiryReferencesOnly: true,
    expiredAt: new Date(0),
  });
  expect(stored?.files).toEqual([
    { file_id: 'file_input' },
    { file_id: 'file_output' },
    { file_id: 'file_cited' },
  ]);
  expect(JSON.stringify(stored)).not.toContain('private');
  expect((await models.Message.findById(future._id).lean())?.text).toBe('private body');
  expect(await methods.getMessage({ user: owner, messageId: expired.messageId })).toBeNull();
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toEqual({
    scanned: 0,
    compacted: 0,
    retained: 0,
  });
});

test('compaction restores tenant context and does not merge reused IDs across tenants', async () => {
  let id = '';
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
    id = (await fixture()).messageId;
  });
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    const other = await fixture(new Date('2100-01-01'));
    await models.Message.updateOne({ _id: other._id }, { messageId: id });
  });
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toMatchObject({
    compacted: 1,
  });
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    expect((await models.Message.findOne({ messageId: id }).lean())?.text).toBe('private body');
  });
});

test('a renewed deadline between discovery and replacement retains the current content', async () => {
  const row = await fixture();
  beforeReplace = async () => {
    await models.Message.updateOne({ _id: row._id }, { expiredAt: new Date('2100-01-01') });
  };
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toEqual({
    scanned: 1,
    compacted: 0,
    retained: 1,
  });
  expect((await models.Message.findById(row._id).lean())?.text).toBe('private body');
});

test('compaction requires system scope and a bounded valid scan', async () => {
  await expect(methods.compactExpiredMessages()).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await expect(methods.compactExpiredMessages(0)).rejects.toThrow('invalid_message_expiry_scan');
    await expect(methods.compactExpiredMessages(1, new Date('invalid'))).rejects.toThrow(
      'invalid_message_expiry_scan',
    );
  });
});

test('reference changes with unchanged timestamps are retained and captured on the next pass', async () => {
  const row = await fixture();
  beforeReplace = async () => {
    await models.Message.updateOne(
      { _id: row._id },
      { files: [{ file_id: 'file_late' }] },
      { timestamps: false },
    );
  };
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toMatchObject({
    compacted: 0,
    retained: 1,
  });
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toMatchObject({
    compacted: 1,
  });
  expect((await models.Message.findById(row._id).lean())?.files).toContainEqual({
    file_id: 'file_late',
  });
});

test('message TTL migration is idempotent and retains the message and reference record', async () => {
  const row = await fixture(new Date('2100-01-01'));
  await models.Message.collection.dropIndex('expiredAt_1');
  await models.Message.collection.createIndex({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  await expect(methods.prepareMessageExpiryIndex()).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await methods.prepareMessageExpiryIndex();
    await methods.prepareMessageExpiryIndex();
  });
  expect(
    (await models.Message.collection.indexes()).find((index) => index.name === 'expiredAt_1')
      ?.expireAfterSeconds,
  ).toBeUndefined();
  expect(await models.Message.countDocuments({ _id: row._id })).toBe(1);
});

test('orphan discovery excludes scopes with a parent or any unexpired message before limiting', async () => {
  const parented = await fixture();
  await models.Conversation.create({
    user: owner,
    conversationId: parented.conversationId,
    endpoint: 'SG AI Gateway',
  });
  const pendingParent = await fixture();
  const live = await fixture(new Date('2100-01-01'));
  await models.Message.updateOne(
    { _id: live._id },
    { conversationId: pendingParent.conversationId },
  );
  const orphan = await fixture();
  await runAsSystem(async () => {
    await methods.compactExpiredMessages();
    expect(await methods.getExpiredOrphanMessageScopes(1)).toEqual([
      { user: owner, conversationId: orphan.conversationId },
    ]);
  });
});

test('a subsequent message write clears the compacted marker so expired content is removed again', async () => {
  const row = await fixture();
  await runAsSystem(async () => methods.compactExpiredMessages());
  await models.Message.updateOne({ _id: row._id }, { text: 'late private content' });
  expect((await models.Message.findById(row._id).lean())?.expiryReferencesOnly).toBeUndefined();
  expect(await runAsSystem(async () => methods.compactExpiredMessages())).toMatchObject({
    compacted: 1,
  });
  expect((await models.Message.findById(row._id).lean())?.text).toBeUndefined();
});

test('a 1005-message backlog resumes after an interrupted batch without losing references or touching live messages', async () => {
  const conversationId = uuidv4();
  await models.Message.insertMany(
    Array.from({ length: 1022 }, (_, index) => ({
      user: owner,
      conversationId,
      messageId: uuidv4(),
      isCreatedByUser: true,
      expiredAt: index < 1005 ? new Date(0) : new Date('2100-01-01'),
      text: `synthetic body ${index}`,
      files: [{ file_id: `file_backlog_${index}`, filename: `synthetic-${index}.txt` }],
    })),
  );
  let writes = 0;
  const interrupt = async () => {
    writes++;
    if (writes === 31) throw new Error('synthetic_interrupted_batch');
    beforeReplace = interrupt;
  };
  beforeReplace = interrupt;
  await expect(runAsSystem(async () => methods.compactExpiredMessages(100))).rejects.toThrow(
    'synthetic_interrupted_batch',
  );
  expect(await models.Message.countDocuments({ expiryReferencesOnly: true })).toBe(30);
  let recovered = 0;
  let finished = false;
  for (let pass = 0; pass < 12; pass++) {
    const result = await runAsSystem(async () => methods.compactExpiredMessages(100));
    expect(result.scanned).toBeLessThanOrEqual(100);
    recovered += result.compacted;
    if (result.scanned === 0) {
      finished = true;
      break;
    }
  }
  expect(finished).toBe(true);
  expect(recovered).toBe(975);
  expect(await models.Message.countDocuments({ expiryReferencesOnly: true })).toBe(1005);
  expect(await models.Message.countDocuments({ text: { $exists: true } })).toBe(17);
  const references = await models.Message.find({ expiryReferencesOnly: true })
    .select('files')
    .lean();
  expect(references.flatMap((row) => row.files ?? [])).toEqual(
    expect.arrayContaining(
      Array.from({ length: 1005 }, (_, index) => ({ file_id: `file_backlog_${index}` })),
    ),
  );
  expect(await models.Message.countDocuments()).toBe(1022);
}, 30_000);
