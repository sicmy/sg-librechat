import { createHash, randomUUID } from 'crypto';
import type { Model } from 'mongoose';
import type { ResourceDeletionRecord, ResourceDeletionTarget } from '~/models/resourceDeletion';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export interface ResourceDeletionMethods {
  getDeletedFileIds(userId: string, fileIds: string[]): Promise<string[]>;
  recordReconciliationFiles(
    userId: string,
    id: string,
    token: string,
    fileIds: string[],
  ): Promise<boolean>;
  listResourceReconciliations(limit?: number): Promise<ResourceDeletionRecord[]>;
  claimResourceReconciliation(userId: string, id: string): Promise<ResourceDeletionRecord | null>;
  finishResourceReconciliation(
    userId: string,
    id: string,
    token: string,
    failed?: boolean,
  ): Promise<boolean>;
  findResourceDeletion(
    userId: string,
    kind: ResourceDeletionTarget['kind'],
    resourceIds: string[],
  ): Promise<ResourceDeletionRecord | null>;
  getResourceDeletion(userId: string, id: string): Promise<ResourceDeletionRecord | null>;
  beginResourceDeletion(
    userId: string,
    target: ResourceDeletionTarget,
    fileIds?: string[],
  ): Promise<ResourceDeletionRecord>;
  claimResourceDeletion(
    userId: string,
    id: string,
    leaseSeconds?: number,
  ): Promise<ResourceDeletionRecord | null>;
  recordResourceDeletionTargets(
    userId: string,
    id: string,
    leaseToken: string,
    fileIds: string[],
    requestIds: string[],
  ): Promise<boolean>;
  finishResourceDeletion(userId: string, id: string, leaseToken: string): Promise<boolean>;
  releaseResourceDeletion(
    userId: string,
    id: string,
    leaseToken: string,
    code: NonNullable<ResourceDeletionRecord['errorCode']>,
  ): Promise<boolean>;
  listPendingResourceDeletions(
    limit?: number,
    kind?: ResourceDeletionTarget['kind'],
  ): Promise<ResourceDeletionRecord[]>;
  isResourceWriteBlocked(
    userId: string,
    conversationIds: string[],
    fileIds?: string[],
    requestMessageId?: string,
  ): Promise<boolean>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validateIds(ids: string[]): void {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !identifier.test(id))) {
    throw new Error('invalid_resource_deletion_identifiers');
  }
}

function deletionId(
  userId: string,
  kind: ResourceDeletionTarget['kind'],
  resourceIds: string[],
): string {
  validateIds([userId, ...resourceIds]);
  if (!resourceIds.length || !['file', 'conversation'].includes(kind))
    throw new Error('invalid_resource_deletion_target');
  return createHash('sha256')
    .update(JSON.stringify([getTenantId() ?? '', userId, kind, [...new Set(resourceIds)].sort()]))
    .digest('hex');
}

export function createResourceDeletionMethods(
  mongoose: typeof import('mongoose'),
): ResourceDeletionMethods {
  const model = () => mongoose.models.ResourceDeletion as Model<ResourceDeletionRecord>;
  return {
    async getDeletedFileIds(userId, fileIds) {
      validateIds([userId]);
      const candidates = [
        ...new Set(fileIds.filter((id) => typeof id === 'string' && identifier.test(id))),
      ];
      const deleted = new Set<string>();
      for (let offset = 0; offset < candidates.length; offset += 200) {
        const selected = new Set(candidates.slice(offset, offset + 200));
        const rows = await model()
          .find({ userId, fileIds: { $in: [...selected] } })
          .select('fileIds')
          .lean();
        for (const row of rows) for (const id of row.fileIds) if (selected.has(id)) deleted.add(id);
      }
      return [...deleted];
    },
    async recordReconciliationFiles(userId, id, token, fileIds) {
      validateIds([userId, id, token]);
      validateIds(fileIds);
      const result = await model().updateOne(
        { _id: id, userId, state: 'complete', leaseToken: token, leaseUntil: { $gt: new Date() } },
        { $addToSet: { fileIds: { $each: fileIds } } },
      );
      return result.matchedCount === 1;
    },
    async listResourceReconciliations(limit = 8) {
      if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('invalid_deletion_page');
      return model()
        .find({
          state: 'complete',
          remoteComplete: true,
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }],
        })
        .sort({ reconciledAt: 1, _id: 1 })
        .limit(limit)
        .lean();
    },
    async claimResourceReconciliation(userId, id) {
      validateIds([userId, id]);
      const now = new Date();
      return model()
        .findOneAndUpdate(
          {
            _id: id,
            userId,
            state: 'complete',
            remoteComplete: true,
            $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
          },
          {
            $set: { leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 120_000) },
            $inc: { reconcileAttempts: 1 },
          },
          { new: true },
        )
        .lean();
    },
    async finishResourceReconciliation(userId, id, token, failed = false) {
      validateIds([userId, id, token]);
      const result = await model().updateOne(
        { _id: id, userId, state: 'complete', leaseToken: token, leaseUntil: { $gt: new Date() } },
        {
          $set: {
            leaseToken: null,
            leaseUntil: null,
            reconciledAt: new Date(),
            reconcileFailed: failed,
          },
        },
      );
      return result.matchedCount === 1;
    },
    async findResourceDeletion(userId, kind, resourceIds) {
      return model()
        .findOne({ _id: deletionId(userId, kind, resourceIds), userId })
        .lean();
    },
    async getResourceDeletion(userId, id) {
      validateIds([userId, id]);
      return model().findOne({ _id: id, userId }).lean();
    },
    async beginResourceDeletion(userId, target, fileIds = []) {
      const actor = getUserId();
      if (actor && actor !== userId) throw new Error('resource_deletion_owner_mismatch');
      validateIds([userId, ...target.resourceIds]);
      validateIds(fileIds);
      validateIds(target.protectedFileIds ?? []);
      if (
        !target.resourceIds.length ||
        (target.kind === 'file' && target.resourceIds.length !== 1) ||
        !['file', 'conversation'].includes(target.kind) ||
        getTenantId() === SYSTEM_TENANT_ID
      ) {
        throw new Error('invalid_resource_deletion_target');
      }
      const resourceIds = [...new Set(target.resourceIds)].sort();
      const gateways = [
        ...new Map(
          target.gateways.map((gateway) => {
            validateIds([gateway.conversationId]);
            if (
              typeof gateway.endpoint !== 'string' ||
              !gateway.endpoint.trim() ||
              gateway.endpoint.length > 256
            ) {
              throw new Error('invalid_resource_deletion_endpoint');
            }
            return [
              JSON.stringify([gateway.endpoint, gateway.conversationId]),
              { endpoint: gateway.endpoint, conversationId: gateway.conversationId },
            ] as const;
          }),
        ).entries(),
      ]
        .sort(([a], [b]) => {
          if (a === b) return 0;
          return a < b ? -1 : 1;
        })
        .map(([, gateway]) => gateway);
      const id = deletionId(userId, target.kind, resourceIds);
      const row = await model()
        .findOneAndUpdate(
          { _id: id, userId },
          {
            $setOnInsert: {
              userId,
              kind: target.kind,
              resourceIds,
              protectedFileIds: [...new Set(target.protectedFileIds ?? [])].sort(),
              gateways,
              state: 'pending',
              fileIds: [...new Set([...(target.kind === 'file' ? resourceIds : []), ...fileIds])],
              requestMessageIds: [],
              attempts: 0,
            },
          },
          { upsert: true, new: true },
        )
        .lean()
        .catch(async (error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
            return model().findOne({ _id: id, userId }).lean();
          }
          throw error;
        });
      if (!row || JSON.stringify(row.gateways) !== JSON.stringify(gateways)) {
        throw new Error('resource_deletion_target_conflict');
      }
      return row;
    },
    async claimResourceDeletion(userId, id, leaseSeconds = 120) {
      validateIds([userId, id]);
      if (!Number.isFinite(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600)
        throw new Error('invalid_deletion_lease');
      const now = new Date();
      return model()
        .findOneAndUpdate(
          {
            _id: id,
            userId,
            state: 'pending',
            $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
          },
          {
            $set: {
              leaseToken: randomUUID(),
              leaseUntil: new Date(now.getTime() + leaseSeconds * 1000),
              errorCode: null,
            },
            $inc: { attempts: 1 },
          },
          { new: true },
        )
        .lean();
    },
    async recordResourceDeletionTargets(userId, id, leaseToken, fileIds, requestIds) {
      validateIds([userId, id, leaseToken]);
      validateIds(fileIds);
      validateIds(requestIds);
      const result = await model().updateOne(
        { _id: id, userId, leaseToken, state: 'pending', leaseUntil: { $gt: new Date() } },
        {
          $addToSet: { fileIds: { $each: fileIds }, requestMessageIds: { $each: requestIds } },
          $set: { remoteComplete: true },
        },
      );
      return result.matchedCount === 1;
    },
    async finishResourceDeletion(userId, id, leaseToken) {
      validateIds([userId, id, leaseToken]);
      const result = await model().updateOne(
        {
          _id: id,
          userId,
          leaseToken,
          state: 'pending',
          remoteComplete: true,
          leaseUntil: { $gt: new Date() },
        },
        {
          $set: { state: 'complete', leaseToken: null, leaseUntil: null, errorCode: null },
        },
      );
      return result.modifiedCount === 1;
    },
    async releaseResourceDeletion(userId, id, leaseToken, code) {
      validateIds([userId, id, leaseToken]);
      if (!['cleanup_failed', 'gateway_unavailable', 'storage_unavailable'].includes(code))
        throw new Error('invalid_deletion_error_code');
      const result = await model().updateOne(
        { _id: id, userId, leaseToken, state: 'pending', leaseUntil: { $gt: new Date() } },
        {
          $set: { leaseToken: null, leaseUntil: null, errorCode: code },
        },
      );
      return result.modifiedCount === 1;
    },
    async listPendingResourceDeletions(limit = 100, kind) {
      if (kind !== undefined && !['file', 'conversation'].includes(kind))
        throw new Error('invalid_deletion_kind');
      if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('invalid_deletion_page');
      return model()
        .find({
          state: 'pending',
          ...(kind ? { kind } : {}),
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }],
        })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit)
        .lean();
    },
    async isResourceWriteBlocked(userId, conversationIds, fileIds = [], requestMessageId) {
      if (!userId) throw new Error('resource_owner_required');
      validateIds(conversationIds);
      validateIds(fileIds);
      if (requestMessageId !== undefined) validateIds([requestMessageId]);
      return !!(await model().exists({
        userId,
        $or: [
          { kind: 'conversation', resourceIds: { $in: conversationIds } },
          { kind: 'conversation', 'gateways.conversationId': { $in: conversationIds } },
          { fileIds: { $in: fileIds } },
          { requestMessageIds: { $in: requestMessageId ? [requestMessageId] : [] } },
        ],
      }));
    },
  };
}
