import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export async function prepareRetentionIndex(
  mongoose: typeof import('mongoose'),
  modelName: 'Conversation' | 'Message',
): Promise<void> {
  if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
  const collection = mongoose.models[modelName].collection;
  if (modelName === 'Message')
    await collection.createIndex({ expiryReferencesOnly: 1, expiredAt: 1 });
  const indexes = await collection.indexes().catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 26) return [];
    throw error;
  });
  const index = indexes.find(
    (item) => item.key.expiredAt === 1 && Object.keys(item.key).length === 1,
  );
  if (index && index.expireAfterSeconds == null) return;
  if (index) {
    if (!index.name) throw new Error('retention_index_invalid');
    await collection.dropIndex(index.name).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 27) return;
      throw error;
    });
  }
  await collection.createIndex({ expiredAt: 1 });
}
