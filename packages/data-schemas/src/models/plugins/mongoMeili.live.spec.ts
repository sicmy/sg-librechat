import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { MeiliSearch } from 'meilisearch';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { SchemaWithMeiliMethods } from './mongoMeili';
import { runAsSystem } from '~/config/tenantContext';
import mongoMeili from './mongoMeili';

const host = process.env.SG_MEILI_SMOKE_URL;
const describeSmoke = host ? describe : describe.skip;

describeSmoke('isolated Meili expiry integration', () => {
  test('real Meili expiry cleanup removes expired and orphaned bodies while preserving a live document', async () => {
    if (!host || !/^http:\/\/127\.0\.0\.1:\d+$/.test(host))
      throw new Error('isolated_loopback_required');
    const apiKey = 'synthetic-sg-expiry-smoke-key';
    const client = new MeiliSearch({ host, apiKey });
    const indexName = `sg_expiry_${randomUUID().replace(/-/g, '')}`;
    const mongo = await MongoMemoryServer.create();
    try {
      await mongoose.connect(mongo.getUri());
      const created = await client.createIndex(indexName, { primaryKey: 'docId' });
      await client.waitForTask(created.taskUid, { timeOutMs: 10_000 });
      const index = client.index(indexName);
      interface Entry {
        docId: string;
        user: string;
        text: string;
        isTemporary?: boolean;
        expiredAt?: Date;
      }
      const schema = new mongoose.Schema<Entry>({
        docId: String,
        user: String,
        text: String,
        isTemporary: Boolean,
        expiredAt: Date,
      });
      schema.plugin(mongoMeili, { mongoose, host, apiKey, indexName, primaryKey: 'docId' });
      const Model = mongoose.model<Entry>(indexName, schema) as mongoose.Model<Entry> &
        Pick<SchemaWithMeiliMethods, 'sweepMeiliIndex'>;
      await Model.insertMany([
        { docId: 'live', user: 'synthetic-owner', text: 'live body', isTemporary: false },
        {
          docId: 'expired',
          user: 'synthetic-owner',
          text: 'expired body',
          expiredAt: new Date(0),
          isTemporary: false,
        },
      ]);
      const indexed = await index.addDocuments([
        { docId: 'live', user: 'synthetic-owner', text: 'live body' },
        { docId: 'expired', user: 'synthetic-owner', text: 'expired body' },
        { docId: 'orphan', user: 'synthetic-owner', text: 'orphan body' },
      ]);
      await index.waitForTask(indexed.taskUid, { timeOutMs: 10_000 });
      expect((await index.getDocuments({ limit: 10 })).results).toHaveLength(3);
      const result = await runAsSystem(async () => Model.sweepMeiliIndex(2, 8));
      expect(result).toMatchObject({ deleted: 2, complete: true });
      expect((await index.getDocuments({ limit: 10 })).results).toEqual([
        { docId: 'live', user: 'synthetic-owner', text: 'live body' },
      ]);
      expect((await index.search('expired')).hits).toEqual([]);
      expect((await index.search('orphan')).hits).toEqual([]);
      expect((await index.search('live')).hits).toHaveLength(1);
    } finally {
      await mongoose.disconnect();
      await mongo.stop();
      const removed = await client.deleteIndex(indexName);
      await client.waitForTask(removed.taskUid, { timeOutMs: 10_000 });
    }
  }, 60_000);
});
