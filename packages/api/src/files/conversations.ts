import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type {
  AppConfig,
  createMethods,
  ConversationMethods,
  MessageMethods,
  FileMethods,
  ResourceDeletionMethods,
  ResourceDeletionRecord,
} from '@librechat/data-schemas';
import { deleteConvoSharedLinksWithCleanup } from '~/shared-links/service';
import { deleteAgentCheckpoints } from '~/agents/checkpointer';
import type { SGFileDeletionMethods } from './lifecycle';
import {
  planSGConversationDeletion,
  resolveSGDeletionEndpoint,
  purgeFileDeletion,
  discoverSGFileDescendants,
} from './lifecycle';
import { deleteSGGatewayConversation, SGFileGatewayError } from './sg';

export type SGConversationDeletionMethods = ResourceDeletionMethods &
  Pick<ConversationMethods, 'getConversationsForDeletion' | 'deleteConvos'> &
  Pick<MessageMethods, 'getMessages' | 'deleteMessages'> &
  Pick<FileMethods, 'getFiles' | 'deleteOwnedFiles'> &
  Pick<ReturnType<typeof createMethods>, 'deleteToolCalls'>;

type DeletionResult = Awaited<ReturnType<ConversationMethods['deleteConvos']>>;

export async function sweepSGExpiredMessages({
  methods,
  loadConfig,
  limit = 100,
  now = new Date(),
}: {
  methods: SGConversationDeletionMethods &
    Pick<MessageMethods, 'compactExpiredMessages' | 'getExpiredOrphanMessageScopes'> &
    Pick<ConversationMethods, 'getConvoRetention'>;
  loadConfig: (tenantId?: string) => Promise<AppConfig | undefined>;
  limit?: number;
  now?: Date;
}): Promise<{ compacted: number; orphaned: number; deleted: number; failed: number }> {
  const compacted = await runAsSystem(async () => methods.compactExpiredMessages(limit, now));
  const scopes = await runAsSystem(async () => methods.getExpiredOrphanMessageScopes(limit, now));
  let deleted = 0,
    failed = 0;
  for (const scope of scopes) {
    try {
      const removed = await tenantStorage.run(
        { userId: scope.user, tenantId: scope.tenantId },
        async () => {
          if (await methods.getConvoRetention(scope.user, scope.conversationId)) return false;
          const live = await methods.getMessages(
            {
              user: scope.user,
              conversationId: scope.conversationId,
              $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }],
            },
            'messageId',
            { limit: 1, includeDeleted: true },
          );
          if (live.length) return false;
          const appConfig = await loadConfig(scope.tenantId);
          const plan = await planSGConversationDeletion({
            userId: scope.user,
            conversationIds: [scope.conversationId],
            appConfig,
            methods,
          });
          const job = await methods.beginResourceDeletion(scope.user, plan, plan.fileIds);
          await resumeSGConversationDeletion({ job, methods, loadConfig: async () => appConfig });
          return true;
        },
      );
      if (removed) deleted++;
    } catch {
      failed++;
    }
  }
  return { compacted: compacted.compacted, orphaned: scopes.length, deleted, failed };
}

export async function sweepSGExpiredConversations({
  methods,
  loadConfig,
  limit = 50,
  now = new Date(),
}: {
  methods: SGConversationDeletionMethods &
    Pick<ConversationMethods, 'getExpiredConversations' | 'getConvoRetention'>;
  loadConfig: (tenantId?: string) => Promise<AppConfig | undefined>;
  limit?: number;
  now?: Date;
}): Promise<{ scanned: number; deleted: number; retained: number; failed: number }> {
  const rows = await runAsSystem(async () => methods.getExpiredConversations(limit, now));
  let deleted = 0,
    retained = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const userId = row.user;
      if (!userId) throw new Error('conversation_expiry_owner_missing');
      const removed = await tenantStorage.run({ userId, tenantId: row.tenantId }, async () => {
        const current = await methods.getConvoRetention(userId, row.conversationId);
        if (!(current?.expiredAt instanceof Date) || current.expiredAt > now) return false;
        await deleteSGConversations({
          userId,
          conversationIds: [row.conversationId],
          appConfig: await loadConfig(row.tenantId),
          methods,
        });
        return true;
      });
      if (removed) deleted++;
      else retained++;
    } catch {
      failed++;
    }
  }
  return { scanned: rows.length, deleted, retained, failed };
}

export async function reconcileSGDeletion({
  job,
  methods,
  loadConfig,
}: {
  job: ResourceDeletionRecord;
  methods: SGConversationDeletionMethods & SGFileDeletionMethods;
  loadConfig: () => Promise<AppConfig | undefined>;
}): Promise<boolean> {
  const lease = await methods.claimResourceReconciliation(job.userId, job._id);
  if (!lease?.leaseToken) return false;
  const token = lease.leaseToken;
  try {
    if (lease.kind === 'file') {
      const fileIds = await discoverSGFileDescendants(lease, methods);
      if (!(await methods.recordReconciliationFiles(lease.userId, lease._id, token, fileIds))) {
        throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
      }
      await purgeFileDeletion({ ...lease, fileIds }, methods);
    } else {
      const files = await methods.getFiles(
        {
          user: lease.userId,
          source: FileSources.sg_gateway,
          file_id: { $nin: lease.protectedFileIds ?? [] },
          $or: [
            { conversationId: { $in: lease.resourceIds } },
            ...lease.gateways.map((gateway) => ({
              'metadata.sgGateway.endpoint': gateway.endpoint,
              'metadata.sgGateway.conversationId': gateway.conversationId,
            })),
            { file_id: { $in: lease.fileIds } },
          ],
        },
        undefined,
        'file_id',
        { includeDeleted: true },
      );
      await methods.deleteOwnedFiles(
        (files ?? []).map((file) => file.file_id),
        { userId: lease.userId, tenantId: lease.tenantId },
      );
      const live = new Set(await methods.getConversationsForDeletion(lease.userId));
      const selected = lease.resourceIds.filter((id) => live.has(id));
      if (selected.length)
        await methods.deleteConvos(lease.userId, { conversationId: { $in: selected } });
      await methods.deleteMessages({
        user: lease.userId,
        conversationId: { $in: lease.resourceIds },
      });
      await cleanupConversationAuxiliary(lease, methods, await loadConfig());
    }
    if (!(await methods.finishResourceReconciliation(lease.userId, lease._id, token))) {
      throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
    }
    return true;
  } catch (error) {
    await methods
      .finishResourceReconciliation(lease.userId, lease._id, token, true)
      .catch(() => false);
    throw error;
  }
}

async function cleanupConversationAuxiliary(
  job: ResourceDeletionRecord,
  methods: SGConversationDeletionMethods,
  config?: AppConfig,
): Promise<void> {
  for (const id of job.resourceIds) {
    await methods.deleteToolCalls(job.userId, id);
    await deleteConvoSharedLinksWithCleanup(job.userId, id, true);
  }
  await deleteAgentCheckpoints(
    job.resourceIds,
    config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
    true,
  );
}

export async function resumeSGConversationDeletion({
  job,
  methods,
  loadConfig,
}: {
  job: ResourceDeletionRecord;
  methods: SGConversationDeletionMethods;
  loadConfig: () => Promise<AppConfig | undefined>;
}): Promise<DeletionResult> {
  if (job.kind !== 'conversation' || !job.resourceIds.length) {
    throw new SGFileGatewayError(409, 'sg_deletion_target_invalid');
  }
  const lease = await methods.claimResourceDeletion(job.userId, job._id);
  if (!lease?.leaseToken) {
    const current = await methods.getResourceDeletion(job.userId, job._id);
    if (current?.state === 'complete')
      return {
        acknowledged: true,
        deletedCount: 0,
        messages: { acknowledged: true, deletedCount: 0 },
        conversationIds: current.resourceIds,
      };
    throw new SGFileGatewayError(409, 'sg_deletion_in_progress');
  }
  const token = lease.leaseToken;
  try {
    const config = await loadConfig();
    if (!lease.remoteComplete) {
      for (const gateway of lease.gateways) {
        const endpointConfig = resolveSGDeletionEndpoint(gateway.endpoint, config);
        if (!endpointConfig) throw new SGFileGatewayError(503, 'sg_file_endpoint_unavailable');
        await deleteSGGatewayConversation({
          endpointConfig,
          conversationId: gateway.conversationId,
          userId: lease.userId,
          tenantId: lease.tenantId,
          allowedAddresses: config?.endpoints?.allowedAddresses,
        });
      }
      if (
        !(await methods.recordResourceDeletionTargets(
          lease.userId,
          lease._id,
          token,
          lease.fileIds,
          [],
        ))
      ) {
        throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
      }
    }
    await methods.deleteOwnedFiles(lease.fileIds, {
      userId: lease.userId,
      tenantId: lease.tenantId,
    });
    const live = new Set(await methods.getConversationsForDeletion(lease.userId));
    const selected = lease.resourceIds.filter((id) => live.has(id));
    const result: DeletionResult = selected.length
      ? await methods.deleteConvos(lease.userId, { conversationId: { $in: selected } })
      : {
          acknowledged: true,
          deletedCount: 0,
          messages: { acknowledged: true, deletedCount: 0 },
          conversationIds: [],
        };
    const messages = await methods.deleteMessages({
      user: lease.userId,
      conversationId: { $in: lease.resourceIds },
    });
    await cleanupConversationAuxiliary(lease, methods, config);
    if (!(await methods.finishResourceDeletion(lease.userId, lease._id, token))) {
      throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
    }
    return {
      ...result,
      conversationIds: lease.resourceIds,
      messages: {
        acknowledged: messages.acknowledged,
        deletedCount: result.messages.deletedCount + messages.deletedCount,
      },
    };
  } catch (error) {
    await methods
      .releaseResourceDeletion(lease.userId, lease._id, token, 'cleanup_failed')
      .catch(() => false);
    throw error;
  }
}

export async function deleteSGConversations({
  userId,
  conversationIds,
  appConfig,
  methods,
}: {
  userId: string;
  conversationIds: string[];
  appConfig?: AppConfig;
  methods: SGConversationDeletionMethods;
}): Promise<DeletionResult> {
  if (!conversationIds.length)
    return {
      acknowledged: true,
      deletedCount: 0,
      messages: { acknowledged: true, deletedCount: 0 },
      conversationIds: [],
    };
  let job = await methods.findResourceDeletion(userId, 'conversation', conversationIds);
  if (!job) {
    const owned = new Set(await methods.getConversationsForDeletion(userId));
    if (conversationIds.some((id) => !owned.has(id)))
      throw new SGFileGatewayError(404, 'conversation_not_found');
    const plan = await planSGConversationDeletion({ userId, conversationIds, appConfig, methods });
    job = await methods.beginResourceDeletion(userId, plan, plan.fileIds);
  }
  return resumeSGConversationDeletion({ job, methods, loadConfig: async () => appConfig });
}
