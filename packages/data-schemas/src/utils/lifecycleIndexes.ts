import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/** Call after the explicit retention migrations; do not activate unrelated storage TTLs. */
export async function prepareLifecycleIndexes(mongoose: typeof import('mongoose')): Promise<void> {
  if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
  for (const name of ['Conversation', 'Message', 'File', 'ResourceDeletion']) {
    const model = mongoose.models[name];
    if (!model) throw new Error('lifecycle_model_missing');
    for (const [keys, options] of model.schema.indexes()) {
      if (options.expireAfterSeconds != null) continue;
      const definition = Object.entries(keys).map(([field, direction]): [string, 1 | -1] => {
        if (direction !== 1 && direction !== -1) throw new Error('unsupported_lifecycle_index');
        return [field, direction];
      });
      const { unique, ...indexOptions } = options;
      // eslint-disable-next-line no-restricted-syntax -- System-only schema index DDL, never document writes.
      await model.collection.createIndex(definition, {
        ...indexOptions,
        ...(unique == null ? {} : { unique: Array.isArray(unique) ? unique[0] : unique }),
      });
    }
  }
}
