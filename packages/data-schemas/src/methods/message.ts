import {
  RetentionMode,
  sgGenerationReceiptSchema,
  sgArtifactMetadataSchema,
  sgCitationMetadataSchema,
} from 'librechat-data-provider';
import type { SGGenerationReceipt, SGArtifactMetadata } from 'librechat-data-provider';
import type { DeleteResult, FilterQuery, Model, PipelineStage } from 'mongoose';
import type { AppConfig, IMessage, IConversation } from '~/types';
import { createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { activeExpirationFilter, createFallbackRetentionDate } from '~/utils/retention';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import {
  assertResourceWritable,
  conversationBatchScopes,
  assertConversationBatchWritable,
  resourceBatchTenantFilter,
} from '~/utils/resourceWrite';
import { excludeDeletedConversations } from '~/utils/resourceRead';
import { redactDeletedFileReferences } from '~/utils/resourceReferences';
import logger from '~/config/winston';
import { compactExpiredMessages, getExpiredOrphanMessageScopes } from './messageExpiry';
import type { MessageExpiryResult, ExpiredMessageScope } from './messageExpiry';
import { prepareRetentionIndex } from '~/utils/retentionIndex';

/** Simple UUID v4 regex to replace zod validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageQueryOptions {
  includeDeleted?: boolean;
  limit?: number;
  sort?: Record<string, 1 | -1> | false;
}

export interface MessageMethods {
  compactExpiredMessages(limit?: number, now?: Date): Promise<MessageExpiryResult>;
  getExpiredOrphanMessageScopes(limit?: number, now?: Date): Promise<ExpiredMessageScope[]>;
  prepareMessageExpiryIndex(): Promise<void>;
  removeSGFileReferences(
    userId: string,
    conversationId: string,
    fileIds: string[],
    requestIds: string[],
  ): Promise<void>;
  finishSGGenerationMessage(args: {
    userId: string;
    conversationId: string;
    receipt: SGGenerationReceipt;
    artifacts: SGArtifactMetadata;
  }): Promise<boolean>;
  prepareSGGenerationMessage(args: {
    userId: string;
    conversationId: string;
    receipt: SGGenerationReceipt;
    endpoint: string;
    sender: string;
  }): Promise<SGGenerationReceipt>;
  cancelSGGenerationMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void>;
  saveMessage(
    ctx: { userId: string; isTemporary?: boolean; interfaceConfig?: AppConfig['interfaceConfig'] },
    params: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ): Promise<IMessage | null | undefined>;
  bulkSaveMessages(
    messages: Array<Partial<IMessage>>,
    overrideTimestamp?: boolean,
  ): Promise<unknown>;
  recordMessage(params: {
    user: string;
    endpoint?: string;
    messageId: string;
    conversationId?: string;
    parentMessageId?: string;
    [key: string]: unknown;
  }): Promise<IMessage | null>;
  updateMessageText(userId: string, params: { messageId: string; text: string }): Promise<void>;
  updateToolCallResult(params: {
    userId: string;
    messageId: string;
    conversationId: string;
    toolCallId: string;
    agentId?: string;
    output?: string;
    attachments?: unknown[];
  }): Promise<{ matched: boolean; unfinished: boolean }>;
  updateMessage(
    userId: string,
    message: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ): Promise<Partial<IMessage>>;
  deleteMessagesSince(
    userId: string,
    params: { messageId: string; conversationId: string },
  ): Promise<DeleteResult>;
  getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options?: MessageQueryOptions,
  ): Promise<IMessage[]>;
  getMessage(params: { user: string; messageId: string }): Promise<IMessage | null>;
  getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options?: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<{ messages: IMessage[]; nextCursor: string | null }>;
  searchMessages(
    query: string,
    searchOptions: Partial<IMessage>,
    hydrate?: boolean,
  ): Promise<unknown>;
  deleteMessages(filter: FilterQuery<IMessage>): Promise<DeleteResult>;
}

export function createMessageMethods(mongoose: typeof import('mongoose')): MessageMethods {
  async function removeSGFileReferences(
    userId: string,
    conversationId: string,
    fileIds: string[],
    requestIds: string[],
  ): Promise<void> {
    if (!userId || !fileIds.length) throw new Error('invalid_file_cleanup_scope');
    const Message = mongoose.models.Message as Model<IMessage>;
    const ids = new Set(fileIds);
    const requests = new Set(requestIds);
    const filter = {
      user: userId,
      $or: [
        { 'files.file_id': { $in: fileIds } },
        { 'metadata.sgArtifacts.artifacts.file_id': { $in: fileIds } },
        { 'metadata.sgArtifacts.artifacts.source_file_id': { $in: fileIds } },
        { 'metadata.sgCitations.citations.file_id': { $in: fileIds } },
        {
          conversationId,
          'metadata.sgGeneration.requestMessageId': { $in: requestIds },
          $or: [
            { 'metadata.sgGeneration.state': { $ne: 'cancelled' } },
            { 'metadata.sgArtifacts': { $exists: true } },
          ],
        },
      ],
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const messages = await Message.find(filter).lean();
      if (!messages.length) return;
      for (const message of messages) {
        const metadata = { ...message.metadata };
        const artifacts = sgArtifactMetadataSchema.safeParse(metadata.sgArtifacts);
        const citations = sgCitationMetadataSchema.safeParse(metadata.sgCitations);
        const generation = sgGenerationReceiptSchema.safeParse(metadata.sgGeneration);
        const cancelledRequest =
          generation.success &&
          message.conversationId === conversationId &&
          requests.has(generation.data.requestMessageId);
        const messageIds = new Set(ids);
        if (artifacts.success) {
          for (const artifact of artifacts.data.artifacts) {
            if (
              cancelledRequest ||
              ids.has(artifact.file_id) ||
              ids.has(artifact.source_file_id ?? '')
            )
              messageIds.add(artifact.file_id);
          }
        }
        if (artifacts.success) {
          const retained = artifacts.data.artifacts.filter(
            (item) => !messageIds.has(item.file_id) && !messageIds.has(item.source_file_id ?? ''),
          );
          if (retained.length) metadata.sgArtifacts = { ...artifacts.data, artifacts: retained };
          else delete metadata.sgArtifacts;
        } else delete metadata.sgArtifacts;
        if (citations.success) {
          const retained = citations.data.citations.filter((item) => !messageIds.has(item.file_id));
          if (retained.length) metadata.sgCitations = { ...citations.data, citations: retained };
          else delete metadata.sgCitations;
        } else delete metadata.sgCitations;
        if (
          generation.success &&
          message.conversationId === conversationId &&
          requests.has(generation.data.requestMessageId)
        ) {
          metadata.sgGeneration = { ...generation.data, state: 'cancelled' };
        }
        const files = (message.files ?? []).filter(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            !('file_id' in item) ||
            typeof item.file_id !== 'string' ||
            !messageIds.has(item.file_id),
        );
        await Message.updateOne(
          {
            user: userId,
            messageId: message.messageId,
            conversationId: message.conversationId,
            updatedAt: message.updatedAt ?? { $exists: false },
            metadata:
              message.metadata === undefined ? { $exists: false } : { $eq: message.metadata },
            files: message.files === undefined ? { $exists: false } : { $eq: message.files },
          },
          { $set: { metadata, files } },
        );
      }
    }
    if (await Message.exists(filter)) throw new Error('sg_file_reference_cleanup_conflict');
  }
  async function finishSGGenerationMessage({
    userId,
    conversationId,
    receipt,
    artifacts,
  }: {
    userId: string;
    conversationId: string;
    receipt: SGGenerationReceipt;
    artifacts: SGArtifactMetadata;
  }): Promise<boolean> {
    const validated = sgGenerationReceiptSchema.parse(receipt);
    const metadata = sgArtifactMetadataSchema.parse(artifacts);
    if (
      validated.state !== 'pending' ||
      metadata.artifacts.some((file) => file.conversation_id !== conversationId)
    ) {
      return false;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const writeScope = { userId, conversationIds: [conversationId] };
    const artifactScope = {
      ...writeScope,
      requestMessageId: validated.requestMessageId,
      fileIds: metadata.artifacts.flatMap((artifact) => [
        artifact.file_id,
        ...(artifact.source_file_id ? [artifact.source_file_id] : []),
      ]),
    };
    await assertResourceWritable(mongoose, artifactScope);
    const [conversation, parent] = await Promise.all([
      Conversation.exists({ user: userId, conversationId }),
      Message.exists({
        user: userId,
        conversationId,
        messageId: validated.requestMessageId,
        isCreatedByUser: true,
      }),
    ]);
    if (!conversation || !parent) {
      return false;
    }
    const text = {
      tts: 'Speech generated.',
      image_edit: 'Image edited.',
      image: 'Image generated.',
    }[validated.kind];
    const result = await Message.updateOne(
      {
        user: userId,
        conversationId,
        messageId: validated.responseMessageId,
        parentMessageId: validated.requestMessageId,
        isCreatedByUser: false,
        isTemporary: { $ne: true },
        'metadata.sgGeneration': validated,
        'metadata.sgArtifacts': { $exists: false },
        $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
      },
      {
        $set: {
          'metadata.sgArtifacts': metadata,
          'metadata.sgGeneration.state': 'delivered',
          text,
          content: [{ type: 'text', text }],
          unfinished: false,
          error: false,
        },
      },
    );
    await assertResourceWritable(mongoose, writeScope, async () => {
      await Message.deleteMany({ user: userId, conversationId });
    });
    await assertResourceWritable(mongoose, artifactScope);
    return result.modifiedCount === 1;
  }
  async function prepareSGGenerationMessage({
    userId,
    conversationId,
    receipt,
    endpoint,
    sender,
  }: {
    userId: string;
    conversationId: string;
    receipt: SGGenerationReceipt;
    endpoint: string;
    sender: string;
  }): Promise<SGGenerationReceipt> {
    const validated = sgGenerationReceiptSchema.parse(receipt);
    if (
      !userId ||
      !UUID_REGEX.test(conversationId) ||
      validated.state !== 'pending' ||
      validated.requestMessageId === validated.responseMessageId
    ) {
      throw new Error('sg_generation_invalid_receipt');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const writeScope = { userId, conversationIds: [conversationId] };
    await assertResourceWritable(mongoose, writeScope);
    const [parent, conversation] = await Promise.all([
      Message.findOne({
        user: userId,
        conversationId,
        messageId: validated.requestMessageId,
        isCreatedByUser: true,
      }),
      Conversation.exists({ user: userId, conversationId }),
    ]);
    if (
      !parent ||
      !conversation ||
      parent.isTemporary ||
      (parent.expiredAt != null && parent.expiredAt.getTime() <= Date.now())
    ) {
      throw new Error('sg_generation_parent_not_persisted');
    }
    const record = await Message.findOneAndUpdate(
      { user: userId, messageId: validated.responseMessageId },
      {
        $setOnInsert: {
          user: userId,
          conversationId,
          messageId: validated.responseMessageId,
          parentMessageId: validated.requestMessageId,
          endpoint,
          sender,
          model: 'default',
          text: '',
          content: [],
          isCreatedByUser: false,
          unfinished: true,
          error: false,
          expiredAt: parent.expiredAt,
          metadata: { sgGeneration: validated },
        },
      },
      { upsert: true, new: true },
    );
    const stored = sgGenerationReceiptSchema.safeParse(record?.metadata?.sgGeneration);
    await assertResourceWritable(mongoose, writeScope, async () => {
      await Message.deleteMany({ user: userId, conversationId });
    });
    if (
      !record ||
      record.conversationId !== conversationId ||
      record.isCreatedByUser ||
      record.parentMessageId !== validated.requestMessageId ||
      !stored.success ||
      stored.data.provider !== validated.provider ||
      stored.data.requestMessageId !== validated.requestMessageId ||
      stored.data.responseMessageId !== validated.responseMessageId ||
      stored.data.kind !== validated.kind ||
      stored.data.state !== 'pending'
    ) {
      throw new Error('sg_generation_receipt_conflict');
    }
    return stored.data;
  }

  async function cancelSGGenerationMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const Message = mongoose.models.Message as Model<IMessage>;
    await Message.updateOne(
      {
        user: userId,
        conversationId,
        messageId,
        isCreatedByUser: false,
        'metadata.sgGeneration.responseMessageId': messageId,
        'metadata.sgGeneration.state': 'pending',
      },
      { $set: { 'metadata.sgGeneration.state': 'cancelled', unfinished: true } },
    );
  }
  /**
   * Saves a message in the database.
   */
  async function saveMessage(
    {
      userId,
      isTemporary,
      interfaceConfig,
    }: {
      userId: string;
      isTemporary?: boolean;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    params: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ) {
    if (!userId) {
      throw new Error('User not authenticated');
    }

    const conversationId = params.conversationId as string | undefined;
    if (!conversationId || !UUID_REGEX.test(conversationId)) {
      logger.warn(
        `Invalid conversation ID: ${conversationId} (context: ${metadata?.context ?? 'n/a'})`,
      );
      return;
    }

    const writeScope = { userId, conversationIds: [conversationId] };
    await assertResourceWritable(mongoose, writeScope);

    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const update: Record<string, unknown> = {
        ...params,
        user: userId,
        messageId: params.newMessageId || params.messageId,
      };

      if (interfaceConfig?.retentionMode === RetentionMode.ALL) {
        if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (isTemporary === true) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (isTemporary === false) {
        update.isTemporary = false;
        update.expiredAt = null;
      }

      if (update.tokenCount != null && isNaN(update.tokenCount as number)) {
        logger.warn(
          `Resetting invalid \`tokenCount\` for message \`${params.messageId}\`: ${update.tokenCount}`,
        );
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
        update.tokenCount = 0;
      }
      const message = await Message.findOneAndUpdate(
        { messageId: params.messageId, user: userId },
        update,
        { upsert: true, new: true },
      );

      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        typeof isTemporary !== 'boolean' &&
        (message.isTemporary == null ||
          (message.isTemporary === false && message.$isDefault('isTemporary')))
      ) {
        await Message.updateOne(
          { _id: message._id, isTemporary: { $ne: false } },
          { $set: { isTemporary: false } },
        );
        message.isTemporary = false;
      }

      await assertResourceWritable(mongoose, writeScope, async () => {
        await Message.deleteMany({ user: userId, conversationId });
      });
      return (await getMessage({ user: userId, messageId: message.messageId })) ?? undefined;
    } catch (err: unknown) {
      logger.error('Error saving message:', err);
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);

      const mongoErr = err as { code?: number; message?: string };
      if (mongoErr.code === 11000 && mongoErr.message?.includes('duplicate key error')) {
        logger.warn(`Duplicate messageId detected: ${params.messageId}. Continuing execution.`);

        try {
          const Message = mongoose.models.Message as Model<IMessage>;
          const existingMessage = await Message.findOne({
            messageId: params.messageId,
            user: userId,
          });

          if (existingMessage) {
            await assertResourceWritable(mongoose, writeScope, async () => {
              await Message.deleteMany({ user: userId, conversationId });
            });
            return (
              (await getMessage({ user: userId, messageId: existingMessage.messageId })) ??
              undefined
            );
          }

          return undefined;
        } catch (findError) {
          logger.warn(
            `Could not retrieve existing message with ID ${params.messageId}: ${(findError as Error).message}`,
          );
          return undefined;
        }
      }

      throw err;
    }
  }

  /**
   * Saves multiple messages in bulk.
   */
  async function bulkSaveMessages(
    messages: Array<Record<string, unknown>>,
    overrideTimestamp = false,
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const scopes = conversationBatchScopes(messages);
      await assertConversationBatchWritable(mongoose, scopes);
      const tenant = resourceBatchTenantFilter();
      const bulkOps = messages.map((message) => ({
        updateOne: {
          filter: { messageId: message.messageId, user: message.user, ...tenant },
          update: { $set: { ...message, expiryReferencesOnly: false } },
          timestamps: !overrideTimestamp,
          upsert: true,
        },
      }));
      let result;
      try {
        result = await tenantSafeBulkWrite(Message, bulkOps);
      } finally {
        await assertConversationBatchWritable(mongoose, scopes, async (blocked) => {
          await Message.deleteMany({ $and: [tenant, { $or: blocked }] });
        });
      }
      return result;
    } catch (err) {
      logger.error('Error saving messages in bulk:', err);
      throw err;
    }
  }

  /**
   * Records a message in the database (no UUID validation).
   */
  async function recordMessage({
    user,
    endpoint,
    messageId,
    conversationId,
    parentMessageId,
    ...rest
  }: {
    user: string;
    endpoint?: string;
    messageId: string;
    conversationId?: string;
    parentMessageId?: string;
    [key: string]: unknown;
  }) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const writeScope = conversationId
        ? { userId: user, conversationIds: [conversationId] }
        : undefined;
      if (writeScope) await assertResourceWritable(mongoose, writeScope);
      const message = {
        user,
        endpoint,
        messageId,
        conversationId,
        parentMessageId,
        ...rest,
      };

      const recorded = await Message.findOneAndUpdate({ user, messageId }, message, {
        upsert: true,
        new: true,
      });
      if (writeScope)
        await assertResourceWritable(mongoose, writeScope, async () => {
          await Message.deleteMany({ user, conversationId });
        });
      return recorded;
    } catch (err) {
      logger.error('Error recording message:', err);
      throw err;
    }
  }

  /**
   * Updates the text of a message.
   */
  async function updateMessageText(
    userId: string,
    { messageId, text }: { messageId: string; text: string },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const stored = await Message.findOne({ messageId, user: userId })
        .select('_id conversationId')
        .lean();
      if (!stored) return;
      const scope = {
        userId,
        conversationIds: stored.conversationId ? [stored.conversationId] : [],
      };
      await assertResourceWritable(mongoose, scope);
      await Message.updateOne(
        { _id: stored._id, user: userId, conversationId: stored.conversationId ?? null },
        { text },
      );
      await assertResourceWritable(mongoose, scope, async () => {
        await Message.deleteOne({
          _id: stored._id,
          user: userId,
          conversationId: stored.conversationId ?? null,
        });
      });
    } catch (err) {
      logger.error('Error updating message text:', err);
      throw err;
    }
  }

  /**
   * Patches a persisted tool_call content part in place and appends attachments,
   * for results that settle after the turn's message was finalized (background
   * tool calls). Atomic single update so two tasks completing concurrently on
   * the same message cannot lose each other's attachments, and IDEMPOTENT
   * (attachments dedupe by `file_id ?? filepath`, scoped to this tool call so
   * sibling calls sharing a filename keep their own entries) so it can be
   * re-applied to heal a later full-row save that reverted the patch.
   *
   * Returns `matched: false` when the message row does not exist yet (the
   * dispatch turn has not finalized) and surfaces `unfinished` when the
   * matched row is a mid-turn partial save (client disconnect) — the eventual
   * finalize will overwrite the patch with in-memory content, so callers
   * should keep re-applying until a finalized row is patched.
   */
  async function updateToolCallResult({
    userId,
    messageId,
    conversationId,
    toolCallId,
    agentId,
    output,
    attachments,
  }: {
    userId: string;
    messageId: string;
    conversationId: string;
    toolCallId: string;
    /** Scopes the part match when provider tool-call ids repeat across
     *  agents in one response message (e.g. `call_0` per response); a part
     *  without agent identity matches any caller (single-agent runs). */
    agentId?: string;
    output?: string;
    attachments?: unknown[];
  }): Promise<{ matched: boolean; unfinished: boolean }> {
    const stages: Record<string, unknown>[] = [];
    if (output !== undefined) {
      stages.push({
        $set: {
          content: {
            $map: {
              input: { $ifNull: ['$content', []] },
              as: 'part',
              in: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$$part.type', 'tool_call'] },
                      { $eq: ['$$part.tool_call.id', toolCallId] },
                      ...(agentId != null
                        ? [
                            {
                              $in: [
                                { $ifNull: ['$$part.agentId', '$$part.tool_call.agentId'] },
                                [null, agentId],
                              ],
                            },
                          ]
                        : []),
                    ],
                  },
                  {
                    $mergeObjects: [
                      '$$part',
                      {
                        tool_call: {
                          $mergeObjects: ['$$part.tool_call', { output: { $literal: output } }],
                        },
                      },
                    ],
                  },
                  '$$part',
                ],
              },
            },
          },
        },
      });
    }
    if (attachments !== undefined && attachments.length > 0) {
      /** Dedupe key mirrors the resume merge: `file_id ?? filepath`, so
       *  download-fallback attachments (no `file_id`, only a filepath) stay
       *  idempotent across re-applications instead of duplicating per poll. */
      const attachmentKeys = attachments
        .map((attachment) => {
          const { file_id, filepath } = attachment as { file_id?: unknown; filepath?: unknown };
          return typeof file_id === 'string' ? file_id : filepath;
        })
        .filter((key): key is string => typeof key === 'string');
      stages.push({
        $set: {
          attachments: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ['$attachments', []] },
                  as: 'existing',
                  /** Replace only THIS tool call's prior entries: sibling calls
                   *  can legitimately share a `file_id` (the filename claim is
                   *  per-conversation), and the client anchors attachments to
                   *  cards by `toolCallId`. */
                  cond: {
                    $not: [
                      {
                        $and: [
                          {
                            $in: [
                              { $ifNull: ['$$existing.file_id', '$$existing.filepath'] },
                              { $literal: attachmentKeys },
                            ],
                          },
                          { $eq: ['$$existing.toolCallId', toolCallId] },
                          /** Provider tool-call ids repeat across agents in
                           *  handoff messages; a sibling agent's attachment
                           *  under the same id/key must survive (missing
                           *  agent identity = legacy wildcard). */
                          ...(agentId != null
                            ? [
                                {
                                  $in: [{ $ifNull: ['$$existing.agentId', null] }, [null, agentId]],
                                },
                              ]
                            : []),
                        ],
                      },
                    ],
                  },
                },
              },
              { $literal: attachments },
            ],
          },
        },
      });
    }
    if (stages.length === 0) {
      return { matched: false, unfinished: false };
    }
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const scope = { userId, conversationIds: [conversationId] };
      await assertResourceWritable(mongoose, scope);
      const result = await Message.findOneAndUpdate(
        { messageId, user: userId, conversationId },
        stages,
        { new: true, projection: { unfinished: 1 } },
      ).lean<{ unfinished?: boolean } | null>();
      await assertResourceWritable(mongoose, scope, async () => {
        await Message.deleteOne({ messageId, user: userId, conversationId });
      });
      return { matched: result != null, unfinished: result?.unfinished === true };
    } catch (err) {
      logger.error('Error updating tool call result:', err);
      throw err;
    }
  }

  /**
   * Updates a message and returns sanitized fields.
   */
  async function updateMessage(
    userId: string,
    message: { messageId: string; [key: string]: unknown },
    metadata?: { context?: string },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const { messageId, ...update } = message;
      const stored = await Message.findOne({ messageId, user: userId })
        .select('_id conversationId')
        .lean();
      if (!stored) throw new Error('Message not found or user not authorized.');
      const scope = {
        userId,
        conversationIds: [
          ...new Set(
            [
              stored.conversationId,
              typeof update.conversationId === 'string' ? update.conversationId : undefined,
            ].filter((id): id is string => !!id),
          ),
        ],
      };
      await assertResourceWritable(mongoose, scope);
      const updatedMessage = await Message.findOneAndUpdate(
        { _id: stored._id, user: userId, conversationId: stored.conversationId ?? null },
        { $set: { ...update, user: userId } },
        {
          new: true,
        },
      );

      if (!updatedMessage) {
        throw new Error('Message not found or user not authorized.');
      }

      await assertResourceWritable(mongoose, scope, async () => {
        await Message.deleteOne({ _id: updatedMessage._id, user: userId });
      });

      return {
        messageId: updatedMessage.messageId,
        conversationId: updatedMessage.conversationId,
        parentMessageId: updatedMessage.parentMessageId,
        sender: updatedMessage.sender,
        text: updatedMessage.text,
        isCreatedByUser: updatedMessage.isCreatedByUser,
        tokenCount: updatedMessage.tokenCount,
        feedback: updatedMessage.feedback,
        endpoint: updatedMessage.endpoint,
        langfuseSampled: updatedMessage.langfuseSampled,
        langfuseDestinationIds: updatedMessage.langfuseDestinationIds,
      };
    } catch (err) {
      logger.error('Error updating message:', err);
      if (metadata?.context) {
        logger.info(`---\`updateMessage\` context: ${metadata.context}`);
      }
      throw err;
    }
  }

  /**
   * Deletes messages in a conversation since a specific message.
   */
  async function deleteMessagesSince(
    userId: string,
    { messageId, conversationId }: { messageId: string; conversationId: string },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const message = await Message.findOne({ messageId, user: userId }).lean<IMessage>();

      if (message) {
        const query = Message.find({ conversationId, user: userId });
        return await query.deleteMany({
          createdAt: { $gt: message.createdAt },
        });
      }
      return undefined;
    } catch (err) {
      logger.error('Error deleting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves messages from the database.
   */
  async function getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options: MessageQueryOptions = {},
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const query = Message.find(filter);
      if (select) {
        query.select(select);
      }
      if (options.sort !== false) {
        query.sort(options.sort ?? { createdAt: 1 });
      }
      if (options.limit != null && options.limit > 0) {
        query.limit(options.limit);
      }

      if (options.includeDeleted) return await query.lean<IMessage[]>();
      const pipeline: PipelineStage[] = [
        { $match: query.cast(Message) },
        { $match: activeExpirationFilter() },
      ];
      if (options.sort !== false) pipeline.push({ $sort: options.sort ?? { createdAt: 1 } });
      pipeline.push(...excludeDeletedConversations());
      if (options.limit != null && options.limit > 0) pipeline.push({ $limit: options.limit });
      pipeline.push(...redactDeletedFileReferences());
      const projection = query.projection();
      if (projection) {
        const explicit = Object.fromEntries(
          Object.entries(projection).filter(([key]) => !key.startsWith('+')),
        );
        const includes = Object.values(explicit).some((value) => value === 1);
        if (includes) {
          for (const key of Object.keys(projection)) {
            if (key.startsWith('+')) explicit[key.slice(1)] = 1;
          }
        }
        if (!includes && !projection['+_meiliIndex'] && !projection._meiliIndex)
          explicit._meiliIndex = 0;
        if (Object.keys(explicit).length) pipeline.push({ $project: explicit });
      } else pipeline.push({ $unset: '_meiliIndex' });
      return await Message.aggregate<IMessage>(pipeline);
    } catch (err) {
      logger.error('Error getting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves a single message from the database.
   */
  async function getMessage({ user, messageId }: { user: string; messageId: string }) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const rows = await Message.aggregate<IMessage>([
        { $match: { user, messageId } },
        { $match: activeExpirationFilter() },
        ...excludeDeletedConversations(),
        { $limit: 1 },
        ...redactDeletedFileReferences(),
        { $unset: '_meiliIndex' },
      ]);
      return rows[0] ?? null;
    } catch (err) {
      logger.error('Error getting message:', err);
      throw err;
    }
  }

  /**
   * Deletes messages from the database.
   */
  async function deleteMessages(filter: FilterQuery<IMessage>) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      return await Message.deleteMany(filter);
    } catch (err) {
      logger.error('Error deleting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves paginated messages with custom sorting and cursor support.
   */
  async function getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
    } = {},
  ) {
    const Message = mongoose.models.Message as Model<IMessage>;
    const { sortField = 'createdAt', sortOrder = -1, limit = 25, cursor } = options;
    const queryFilter = { ...filter };
    if (cursor) {
      queryFilter[sortField] = sortOrder === 1 ? { $gt: cursor } : { $lt: cursor };
    }
    const castFilter = Message.find(queryFilter).cast(Message);
    const messages = await Message.aggregate<IMessage>([
      { $match: castFilter },
      { $match: activeExpirationFilter() },
      { $sort: { [sortField]: sortOrder } },
      ...excludeDeletedConversations(),
      { $limit: limit + 1 },
      ...redactDeletedFileReferences(),
      { $unset: '_meiliIndex' },
    ]);

    let nextCursor: string | null = null;
    if (messages.length > limit) {
      messages.pop();
      const last = messages[messages.length - 1];
      const cursorValue =
        sortField === 'createdAt' ? last.createdAt : last[sortField as keyof IMessage];
      nextCursor = String(cursorValue ?? '');
    }
    return { messages, nextCursor };
  }

  /**
   * Performs a MeiliSearch query on the Message collection.
   * Requires the meilisearch plugin to be registered on the Message model.
   */
  async function searchMessages(
    query: string,
    searchOptions: Record<string, unknown>,
    hydrate?: boolean,
  ) {
    const Message = mongoose.models.Message as Model<IMessage> & {
      meiliSearch?: (q: string, opts: Record<string, unknown>, h?: boolean) => Promise<unknown>;
    };
    if (typeof Message.meiliSearch !== 'function') {
      throw new Error('MeiliSearch plugin not registered on Message model');
    }
    return Message.meiliSearch(query, searchOptions, hydrate);
  }

  return {
    compactExpiredMessages: (limit, now) => compactExpiredMessages(mongoose, limit, now),
    getExpiredOrphanMessageScopes: (limit, now) =>
      getExpiredOrphanMessageScopes(mongoose, limit, now),
    prepareMessageExpiryIndex: () => prepareRetentionIndex(mongoose, 'Message'),
    removeSGFileReferences,
    finishSGGenerationMessage,
    prepareSGGenerationMessage,
    cancelSGGenerationMessage,
    saveMessage,
    bulkSaveMessages,
    recordMessage,
    updateMessageText,
    updateToolCallResult,
    updateMessage,
    deleteMessagesSince,
    getMessages,
    getMessage,
    getMessagesByCursor,
    searchMessages,
    deleteMessages,
  };
}
