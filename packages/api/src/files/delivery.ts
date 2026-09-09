import type { SGGenerationReceipt, Agents, TPendingSteer } from 'librechat-data-provider';
import type {
  MessageMethods,
  ConversationMethods,
  IConversation,
  ResourceDeletionMethods,
} from '@librechat/data-schemas';
import type { FinalEvent } from '~/types';
import type { IMessage } from '@librechat/data-schemas';
import { logger } from '@librechat/data-schemas';
import { Constants, sgGenerationReceiptSchema } from 'librechat-data-provider';
import { randomUUID } from 'crypto';
import type { SGEndpointConfig } from './sg';
import { SGFileGatewayError, getSGGenerationDelivery, registerSGArtifacts } from './sg';

function cachedFiles(message: object | null | undefined): unknown[] {
  return message &&
    typeof message === 'object' &&
    'files' in message &&
    Array.isArray(message.files)
    ? message.files
    : [];
}
function cachedFileId(file: unknown): string | undefined {
  return file != null &&
    typeof file === 'object' &&
    'file_id' in file &&
    typeof file.file_id === 'string'
    ? file.file_id
    : undefined;
}
function hasSGMetadata(event: FinalEvent): boolean {
  const metadata = event.responseMessage?.metadata;
  return (
    metadata != null &&
    typeof metadata === 'object' &&
    ['sgArtifacts', 'sgCitations', 'sgGeneration'].some((key) => key in metadata)
  );
}
function filterSteerFiles(
  steers: TPendingSteer[] | undefined,
  deleted: Set<string>,
): TPendingSteer[] | undefined {
  return steers?.map((steer) =>
    !steer.files?.some((file) => file.file_id && deleted.has(file.file_id))
      ? steer
      : {
          ...steer,
          files: steer.files.map((file) =>
            file.file_id && deleted.has(file.file_id)
              ? { file_id: file.file_id, status: 'failed' as const }
              : file,
          ),
        },
  );
}
export async function filterSGPendingSteerFiles({
  userId,
  steers,
  methods,
}: {
  userId: string;
  steers: TPendingSteer[];
  methods: Pick<ResourceDeletionMethods, 'getDeletedFileIds'>;
}): Promise<TPendingSteer[]> {
  const ids = steers.flatMap((steer) =>
    (steer.files ?? []).flatMap((file) => (file.file_id ? [file.file_id] : [])),
  );
  if (!ids.length) return steers;
  const deleted = new Set(await methods.getDeletedFileIds(userId, ids));
  return deleted.size ? filterSteerFiles(steers, deleted)! : steers;
}
export function needsSGReplayRefresh(event: FinalEvent | undefined): boolean {
  return (
    event?.final === true &&
    (hasSGMetadata(event) ||
      cachedFiles(event.requestMessage).length > 0 ||
      cachedFiles(event.responseMessage).length > 0 ||
      !!event.pendingSteers?.some((steer) => steer.files?.length))
  );
}

export async function filterSGResumeFiles({
  userId,
  state,
  methods,
}: {
  userId: string;
  state: Agents.ResumeState;
  methods: Pick<ResourceDeletionMethods, 'getDeletedFileIds'>;
}): Promise<Agents.ResumeState> {
  const files = cachedFiles(state.userMessage);
  const pendingFiles = (state.pendingSteers ?? []).flatMap((steer) => steer.files ?? []);
  if (!files.length && !pendingFiles.length) return state;
  const ids = [...files, ...pendingFiles]
    .map(cachedFileId)
    .filter((id): id is string => id != null);
  const deleted = new Set(await methods.getDeletedFileIds(userId, ids));
  if (!deleted.size) return state;
  const userMessage = state.userMessage
    ? {
        ...state.userMessage,
        files: files.filter((file) => !deleted.has(cachedFileId(file) ?? '')),
      }
    : undefined;
  return {
    ...state,
    ...(userMessage && { userMessage }),
    ...(state.pendingSteers && { pendingSteers: filterSteerFiles(state.pendingSteers, deleted) }),
  };
}

export async function refreshSGReplayFinal({
  userId,
  conversationId,
  event,
  methods,
}: {
  userId: string;
  conversationId: string;
  event: FinalEvent;
  methods: Pick<ResourceDeletionMethods, 'getDeletedFileIds'> &
    Pick<MessageMethods, 'getMessages'> &
    Pick<ConversationMethods, 'getConvo'>;
}): Promise<FinalEvent> {
  if (hasSGMetadata(event)) {
    const fresh = await loadSGTerminalSnapshot({
      userId,
      conversationId,
      requestMessageId:
        event.requestMessage?.messageId ?? event.responseMessage?.parentMessageId ?? '',
      responseMessageId: event.responseMessage?.messageId ?? '',
      methods,
    });
    return {
      ...event,
      ...(event.pendingSteers && {
        pendingSteers: await filterSGPendingSteerFiles({
          userId,
          steers: event.pendingSteers,
          methods,
        }),
      }),
      conversation: { ...fresh.conversation },
      title: fresh.conversation.title,
      requestMessage: {
        ...fresh.request,
        parentMessageId: fresh.request.parentMessageId ?? undefined,
      },
      responseMessage: {
        ...fresh.response,
        parentMessageId: fresh.response.parentMessageId ?? undefined,
      },
    };
  }
  const files = cachedFiles(event.requestMessage);
  const responseFiles = cachedFiles(event.responseMessage);
  const pendingFiles = (event.pendingSteers ?? []).flatMap((steer) => steer.files ?? []);
  if (!files.length && !responseFiles.length && !pendingFiles.length) return event;
  const deleted = new Set(
    await methods.getDeletedFileIds(
      userId,
      [...files, ...responseFiles, ...pendingFiles]
        .map(cachedFileId)
        .filter((id): id is string => id != null),
    ),
  );
  if (!deleted.size) return event;
  return {
    ...event,
    ...(event.pendingSteers && { pendingSteers: filterSteerFiles(event.pendingSteers, deleted) }),
    ...(event.requestMessage && {
      requestMessage: {
        ...event.requestMessage,
        files: files.filter((file) => !deleted.has(cachedFileId(file) ?? '')),
      },
    }),
    ...(event.responseMessage && {
      responseMessage: {
        ...event.responseMessage,
        files: responseFiles.filter((file) => !deleted.has(cachedFileId(file) ?? '')),
      },
    }),
  };
}

export async function loadSGTerminalSnapshot({
  userId,
  conversationId,
  requestMessageId,
  responseMessageId,
  methods,
}: {
  userId: string;
  conversationId: string;
  requestMessageId: string;
  responseMessageId: string;
  methods: Pick<MessageMethods, 'getMessages'> & Pick<ConversationMethods, 'getConvo'>;
}): Promise<{ conversation: IConversation; request: IMessage; response: IMessage }> {
  if (
    [userId, conversationId, requestMessageId, responseMessageId].some(
      (value) => typeof value !== 'string' || !value,
    ) ||
    requestMessageId === responseMessageId
  ) {
    throw new SGFileGatewayError(409, 'sg_terminal_snapshot_unavailable');
  }
  const [conversation, messages] = await Promise.all([
    methods.getConvo(userId, conversationId),
    methods.getMessages(
      { user: userId, conversationId, messageId: { $in: [requestMessageId, responseMessageId] } },
      undefined,
      { sort: false, limit: 2 },
    ),
  ]);
  const request = messages.find(
    (message) => message.messageId === requestMessageId && message.isCreatedByUser,
  );
  const response = messages.find(
    (message) => message.messageId === responseMessageId && !message.isCreatedByUser,
  );
  if (!conversation || !request || !response)
    throw new SGFileGatewayError(409, 'sg_terminal_snapshot_unavailable');
  return { conversation, request, response };
}

export async function recoverSGGenerationMessages({
  userId,
  tenantId,
  conversationId,
  messages,
  resolveEndpoint,
  createFile,
  finish,
  allowedAddresses,
}: {
  userId: string;
  tenantId?: string | null;
  conversationId: string;
  messages: Pick<
    IMessage,
    'messageId' | 'parentMessageId' | 'metadata' | 'isCreatedByUser' | 'isTemporary' | 'expiredAt'
  >[];
  resolveEndpoint: (provider: string) => SGEndpointConfig | undefined;
  createFile: Parameters<typeof registerSGArtifacts>[0]['createFile'];
  finish: MessageMethods['finishSGGenerationMessage'];
  allowedAddresses?: string[] | null;
}): Promise<boolean> {
  let changed = false;
  for (const message of messages) {
    if (message.expiredAt != null) {
      const deadline = new Date(message.expiredAt).getTime();
      if (!Number.isFinite(deadline) || deadline <= Date.now()) continue;
    }
    const parsed = sgGenerationReceiptSchema.safeParse(message.metadata?.sgGeneration);
    if (
      message.isCreatedByUser ||
      message.isTemporary ||
      message.metadata?.sgArtifacts ||
      !parsed.success ||
      parsed.data.state !== 'pending' ||
      parsed.data.responseMessageId !== message.messageId ||
      parsed.data.requestMessageId !== message.parentMessageId
    ) {
      continue;
    }
    let stage = 'endpoint';
    try {
      const endpointConfig = resolveEndpoint(parsed.data.provider);
      if (!endpointConfig) continue;
      stage = 'lookup';
      const artifacts = await getSGGenerationDelivery({
        endpointConfig,
        conversationId,
        messageId: parsed.data.requestMessageId,
        userId,
        tenantId,
        allowedAddresses,
      });
      if (!artifacts) continue;
      stage = 'registration';
      await registerSGArtifacts({
        metadata: artifacts,
        retention: { expiredAt: message.expiredAt },
        endpointConfig,
        createFile,
        allowedAddresses,
        scope: {
          userId,
          tenantId,
          conversationId,
          gatewayConversationId: conversationId,
          requestMessageId: parsed.data.requestMessageId,
        },
      });
      stage = 'message';
      changed =
        (await finish({ userId, conversationId, receipt: parsed.data, artifacts })) || changed;
    } catch (error) {
      logger.warn('SG generated message recovery deferred', {
        stage,
        code: error instanceof SGFileGatewayError ? error.code : 'storage_unavailable',
      });
    }
  }
  return changed;
}

type CheckpointMethods = Pick<
  MessageMethods,
  'prepareSGGenerationMessage' | 'cancelSGGenerationMessage'
>;
type ResponseIdentity = {
  responseMessageId: string;
  userMessageId: string;
  endpoint: string;
  sender: string;
};

export function resolveSGRequestMessageId(body: {
  messageId?: string;
  overrideUserMessageId?: string | null;
  overrideParentMessageId?: string | null;
}): string {
  if (typeof body.overrideUserMessageId === 'string' && body.overrideUserMessageId) {
    return body.overrideUserMessageId.split(Constants.COMMON_DIVIDER)[0];
  }
  if (typeof body.overrideParentMessageId === 'string' && body.overrideParentMessageId) {
    return body.overrideParentMessageId;
  }
  const id = typeof body.messageId === 'string' && body.messageId ? body.messageId : randomUUID();
  body.overrideUserMessageId = `${id}${Constants.COMMON_DIVIDER}0`;
  return id;
}

export interface SGGenerationCheckpoint {
  begin(identity: ResponseIdentity): Promise<void>;
  cancel(): Promise<void>;
  getReceipt(registered?: boolean, aborted?: boolean): SGGenerationReceipt | undefined;
}

export function createSGGenerationCheckpoint(
  request: {
    userId: string;
    conversationId: string;
    messageId: string;
    provider: string;
    text?: string;
    isTemporary?: boolean;
  },
  methods: CheckpointMethods,
): SGGenerationCheckpoint | undefined {
  if (request.isTemporary || typeof request.text !== 'string') {
    return undefined;
  }
  const prefix = request.text.trim();
  let kind: SGGenerationReceipt['kind'];
  if (/^(?:Create an image|Generate an image|이미지 생성|그림 생성)\s*:\s*\S/i.test(prefix)) {
    kind = 'image';
  } else if (/^(?:Edit an image|Edit image|이미지 편집|그림 편집)\s*:\s*\S/i.test(prefix)) {
    kind = 'image_edit';
  } else if (/^(?:Read aloud|Create speech|음성 생성|읽어 줘)\s*:\s*\S/i.test(prefix)) {
    kind = 'tts';
  } else {
    return undefined;
  }
  let receipt: SGGenerationReceipt | undefined;
  return {
    async begin(identity) {
      if (identity.userMessageId !== request.messageId) {
        throw new SGFileGatewayError(409, 'sg_generation_request_mismatch');
      }
      receipt = await methods.prepareSGGenerationMessage({
        userId: request.userId,
        conversationId: request.conversationId,
        endpoint: identity.endpoint,
        sender: identity.sender,
        receipt: {
          schema_version: 1,
          kind,
          provider: request.provider,
          state: 'pending',
          requestMessageId: identity.userMessageId,
          responseMessageId: identity.responseMessageId,
        },
      });
    },
    async cancel() {
      if (!receipt) {
        return;
      }
      receipt = { ...receipt, state: 'cancelled' };
      await methods.cancelSGGenerationMessage(
        request.userId,
        request.conversationId,
        receipt.responseMessageId,
      );
    },
    getReceipt(registered = false, aborted = false) {
      if (!receipt) {
        return undefined;
      }
      if (aborted || receipt.state === 'cancelled') {
        return { ...receipt, state: 'cancelled' };
      }
      return { ...receipt, state: registered ? 'delivered' : 'pending' };
    },
  };
}
