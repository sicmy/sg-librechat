import { createResourceDeletionModel } from '~/models/resourceDeletion';
import { createResourceDeletionMethods } from '~/methods/resourceDeletion';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export type ConversationBatchScope = { user: string; conversationId: string };

export function conversationBatchScopes(
  rows: Array<{ user?: unknown; conversationId?: unknown }>,
): ConversationBatchScope[] {
  resourceBatchTenantFilter();
  const actor = getUserId();
  const scopes = new Map<string, ConversationBatchScope>();
  for (const row of rows) {
    if (
      typeof row.user !== 'string' ||
      !row.user ||
      typeof row.conversationId !== 'string' ||
      !row.conversationId
    ) {
      throw new Error('resource_batch_scope_required');
    }
    if (actor && row.user !== actor) throw new Error('resource_batch_owner_mismatch');
    scopes.set(JSON.stringify([row.user, row.conversationId]), {
      user: row.user,
      conversationId: row.conversationId,
    });
  }
  return [...scopes.values()];
}

/** Bulk imports must run in one tenant context, never an ambiguous cross-tenant system scope. */
export function resourceBatchTenantFilter():
  | { tenantId: string }
  | { $or: Array<{ tenantId: { $exists: false } | null }> } {
  const tenantId = getTenantId();
  if (tenantId === SYSTEM_TENANT_ID) throw new Error('resource_batch_tenant_required');
  return tenantId ? { tenantId } : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

export async function assertConversationBatchWritable(
  mongoose: typeof import('mongoose'),
  scopes: ConversationBatchScope[],
  compensate?: (blocked: ConversationBatchScope[]) => Promise<void>,
): Promise<void> {
  if (!scopes.length) return;
  const model = createResourceDeletionModel(mongoose);
  const selected = new Map(
    scopes.map((scope) => [JSON.stringify([scope.user, scope.conversationId]), scope]),
  );
  const blocked = new Map<string, ConversationBatchScope>();
  const tenant = resourceBatchTenantFilter();
  for (let offset = 0; offset < scopes.length; offset += 200) {
    const rows = await model
      .find({
        $and: [
          tenant,
          {
            kind: 'conversation',
            $or: scopes.slice(offset, offset + 200).map((scope) => ({
              userId: scope.user,
              $or: [
                { resourceIds: scope.conversationId },
                { 'gateways.conversationId': scope.conversationId },
              ],
            })),
          },
        ],
      })
      .select('userId resourceIds gateways.conversationId')
      .lean();
    for (const row of rows) {
      for (const id of [
        ...row.resourceIds,
        ...row.gateways.map((gateway) => gateway.conversationId),
      ]) {
        const key = JSON.stringify([row.userId, id]);
        const scope = selected.get(key);
        if (scope) blocked.set(key, scope);
      }
    }
  }
  if (!blocked.size) return;
  if (compensate) await compensate([...blocked.values()]);
  throw new ResourceDeletedError();
}

export interface ResourceWriteScope {
  userId: string;
  conversationIds: string[];
  fileIds?: string[];
  requestMessageId?: string;
}

export class ResourceDeletedError extends Error {
  readonly statusCode = 409;
  readonly code = 'resource_deleted';
  constructor() {
    super('resource_deleted');
  }
}

/** Recheck after persistence and compensate when deletion crossed the write boundary. */
export async function assertResourceWritable(
  mongoose: typeof import('mongoose'),
  scope: ResourceWriteScope,
  compensate?: () => Promise<void>,
): Promise<void> {
  if (!mongoose.models.ResourceDeletion) createResourceDeletionModel(mongoose);
  const blocked = await createResourceDeletionMethods(mongoose).isResourceWriteBlocked(
    scope.userId,
    scope.conversationIds,
    scope.fileIds,
    scope.requestMessageId,
  );
  if (!blocked) return;
  if (compensate) await compensate();
  throw new ResourceDeletedError();
}
