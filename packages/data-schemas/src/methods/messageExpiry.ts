import type { Model } from 'mongoose';
import type { IMessage } from '~/types';
import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';

export type MessageExpiryResult = { scanned: number; compacted: number; retained: number };
export type ExpiredMessageScope = Pick<IMessage, 'user' | 'tenantId' | 'conversationId'>;

export async function getExpiredOrphanMessageScopes(
  mongoose: typeof import('mongoose'),
  limit: number = 50,
  now: Date = new Date(),
): Promise<ExpiredMessageScope[]> {
  if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(now.getTime()))
    throw new Error('invalid_message_expiry_scan');
  const Message = mongoose.models.Message as Model<IMessage>;
  return Message.aggregate<ExpiredMessageScope>([
    { $match: { expiryReferencesOnly: true, expiredAt: { $ne: null, $lte: now } } },
    {
      $group: {
        _id: {
          user: '$user',
          tenantId: { $ifNull: ['$tenantId', null] },
          conversationId: '$conversationId',
        },
      },
    },
    {
      $lookup: {
        from: 'conversations',
        let: { scope: '$_id' },
        as: 'parent',
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$user', '$$scope.user'] },
                  { $eq: ['$conversationId', '$$scope.conversationId'] },
                  { $eq: [{ $ifNull: ['$tenantId', null] }, '$$scope.tenantId'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
      },
    },
    { $match: { parent: { $size: 0 } } },
    {
      $lookup: {
        from: 'messages',
        let: { scope: '$_id' },
        as: 'live',
        pipeline: [
          {
            $match: {
              $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }],
              $expr: {
                $and: [
                  { $eq: ['$user', '$$scope.user'] },
                  { $eq: ['$conversationId', '$$scope.conversationId'] },
                  { $eq: [{ $ifNull: ['$tenantId', null] }, '$$scope.tenantId'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
      },
    },
    { $match: { live: { $size: 0 } } },
    { $sort: { '_id.user': 1, '_id.tenantId': 1, '_id.conversationId': 1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        user: '$_id.user',
        tenantId: { $ifNull: ['$_id.tenantId', '$$REMOVE'] },
        conversationId: '$_id.conversationId',
      },
    },
  ]);
}

/** Mixed legacy metadata is reduced to IDs, never copied into the retained record. */
function referenceIds(message: IMessage): string[] {
  const ids = new Set<string>();
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const key of ['file_id', 'source_file_id']) {
        if (key in item && typeof item[key] === 'string' && item[key]) ids.add(item[key]);
      }
    }
  };
  collect(message.files);
  collect(message.attachments);
  const artifacts = message.metadata?.sgArtifacts;
  if (artifacts && typeof artifacts === 'object' && 'artifacts' in artifacts)
    collect(artifacts.artifacts);
  const citations = message.metadata?.sgCitations;
  if (citations && typeof citations === 'object' && 'citations' in citations)
    collect(citations.citations);
  return [...ids];
}

export async function compactExpiredMessages(
  mongoose: typeof import('mongoose'),
  limit: number = 100,
  now: Date = new Date(),
): Promise<MessageExpiryResult> {
  if (getTenantId() !== SYSTEM_TENANT_ID) throw new Error('system_scope_required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(now.getTime()))
    throw new Error('invalid_message_expiry_scan');
  const Message = mongoose.models.Message as Model<IMessage>;
  const rows = await Message.find({
    expiredAt: { $ne: null, $lte: now },
    expiryReferencesOnly: { $ne: true },
  })
    .sort({ expiredAt: 1, _id: 1 })
    .limit(limit)
    .lean<IMessage[]>();
  let compacted = 0;
  for (const row of rows) {
    if (!row.user || !row.conversationId || !row.messageId) continue;
    const result = await tenantStorage.run({ userId: row.user, tenantId: row.tenantId }, async () =>
      Message.replaceOne(
        {
          _id: row._id,
          user: row.user,
          conversationId: row.conversationId,
          messageId: row.messageId,
          expiredAt: row.expiredAt,
          updatedAt: row.updatedAt ?? null,
          files: { $eq: row.files ?? null },
          metadata: { $eq: row.metadata ?? null },
          attachments: { $eq: row.attachments ?? null },
          expiryReferencesOnly: { $ne: true },
        },
        {
          user: row.user,
          tenantId: row.tenantId,
          conversationId: row.conversationId,
          messageId: row.messageId,
          isCreatedByUser: row.isCreatedByUser,
          expiredAt: row.expiredAt,
          expiryReferencesOnly: true,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          files: referenceIds(row).map((file_id) => ({ file_id })),
        },
        { timestamps: false, runValidators: true },
      ),
    );
    compacted += result.modifiedCount;
  }
  return { scanned: rows.length, compacted, retained: rows.length - compacted };
}
