import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { runAsSystem } from '~/config/tenantContext';
import { prepareLifecycleIndexes } from './lifecycleIndexes';

let server: MongoMemoryServer;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { autoIndex: false, autoCreate: false });
  createModels(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

test('explicit lifecycle indexes are idempotent with autoIndex disabled and do not activate upload TTL', async () => {
  await expect(prepareLifecycleIndexes(mongoose)).rejects.toThrow('system_scope_required');
  await runAsSystem(async () => {
    await prepareLifecycleIndexes(mongoose);
    await prepareLifecycleIndexes(mongoose);
  });
  for (const name of ['Conversation', 'Message', 'File', 'ResourceDeletion']) {
    const model = mongoose.models[name];
    const indexes = await model.collection.indexes();
    for (const [key, options] of model.schema.indexes()) {
      if (options.expireAfterSeconds != null) continue;
      const found = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(key));
      expect(found).toBeDefined();
      if (options.unique) expect(found?.unique).toBe(true);
    }
    expect(indexes.some((index) => index.expireAfterSeconds != null)).toBe(false);
  }
});
