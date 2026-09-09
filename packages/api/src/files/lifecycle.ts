import {
  FileSources,
  EModelEndpoint,
  sgArtifactMetadataSchema,
  extractEnvVariable,
} from 'librechat-data-provider';
import type {
  AppConfig,
  FileMethods,
  MessageMethods,
  ConversationMethods,
  IMessage,
  ResourceDeletionMethods,
  ResourceDeletionRecord,
  ResourceDeletionTarget,
} from '@librechat/data-schemas';
import type { SGEndpointConfig } from './sg';
import type { ExpiredFile } from './sweep';
import { tenantStorage, isSGFileExpired } from '@librechat/data-schemas';
import { getCustomEndpointConfig } from '~/app/config';
import {
  deleteSGGatewayConversation,
  deleteSGGatewayFileTree,
  deleteSGGatewayScopedFileTree,
  isSGFileGatewayEndpoint,
  SGFileGatewayError,
} from './sg';

export type SGFileDeletionMethods = Pick<FileMethods, 'deleteOwnedFiles' | 'getFiles'> &
  Pick<MessageMethods, 'removeSGFileReferences'> &
  ResourceDeletionMethods;

export async function deleteExpiredSGFile({
  file,
  methods,
  loadConfig,
  now = new Date(),
}: {
  file: ExpiredFile;
  methods: SGFileDeletionMethods;
  loadConfig: (tenantId?: string) => Promise<AppConfig | undefined>;
  now?: Date;
}): Promise<{ retained: boolean; fileIds: string[] }> {
  if (!Number.isFinite(now.getTime())) throw new SGFileGatewayError(409, 'sg_expiry_clock_invalid');
  const userId = typeof file.user === 'string' ? file.user : file.user?.toString?.();
  if (!userId || file.source !== FileSources.sg_gateway)
    throw new SGFileGatewayError(409, 'sg_expiry_scope_invalid');
  return tenantStorage.run({ tenantId: file.tenantId, userId }, async () => {
    const [current] =
      (await methods.getFiles({ user: userId, file_id: file.file_id }, undefined, undefined, {
        includeDeleted: true,
      })) ?? [];
    if (current && (current.source !== FileSources.sg_gateway || !isSGFileExpired(current, now)))
      return { retained: true, fileIds: [] };
    const target = current ?? file;
    const config = await loadConfig(file.tenantId);
    const endpointConfig = target.metadata?.sgGateway?.endpoint
      ? resolveSGDeletionEndpoint(target.metadata.sgGateway.endpoint, config)
      : undefined;
    if (!endpointConfig) throw new SGFileGatewayError(503, 'sg_file_endpoint_unavailable');
    const fileIds = await deleteSGFileResources({
      file: target,
      userId,
      tenantId: file.tenantId,
      endpointConfig,
      allowedAddresses: config?.endpoints?.allowedAddresses,
      methods,
    });
    return { retained: false, fileIds };
  });
}

export async function discoverSGFileDescendants(
  job: ResourceDeletionRecord,
  methods: SGFileDeletionMethods,
): Promise<string[]> {
  const known = new Set(job.fileIds);
  let frontier = [...known];
  let first = true;
  while (frontier.length || first) {
    const rows = await methods.getFiles(
      {
        user: job.userId,
        source: FileSources.sg_gateway,
        'metadata.sgGateway.endpoint': job.gateways[0].endpoint,
        $or: [
          { 'metadata.sgGateway.sourceFileId': { $in: frontier } },
          ...(first
            ? [
                {
                  'metadata.sgGateway.requestMessageId': { $in: job.requestMessageIds },
                  'metadata.sgGateway.conversationId': job.gateways[0].conversationId,
                },
              ]
            : []),
        ],
      },
      undefined,
      'file_id',
      { includeDeleted: true },
    );
    first = false;
    frontier = (rows ?? []).map((row) => row.file_id).filter((id) => !known.has(id));
    for (const id of frontier) known.add(id);
  }
  return [...known];
}

export async function purgeFileDeletion(
  job: ResourceDeletionRecord,
  methods: SGFileDeletionMethods,
): Promise<void> {
  const fileId = job.resourceIds[0];
  await methods.removeSGFileReferences(
    job.userId,
    job.gateways[0].conversationId,
    job.fileIds,
    job.requestMessageIds,
  );
  const children = job.fileIds.filter((id) => id !== fileId);
  if (children.length)
    await methods.deleteOwnedFiles(children, { userId: job.userId, tenantId: job.tenantId });
  await methods.deleteOwnedFiles([fileId], { userId: job.userId, tenantId: job.tenantId });
}

export async function resumeSGFileDeletion({
  job,
  methods,
  configuration,
}: {
  job: ResourceDeletionRecord;
  methods: SGFileDeletionMethods;
  configuration: () => Promise<{
    endpointConfig?: SGEndpointConfig;
    allowedAddresses?: string[] | null;
  }>;
}): Promise<string[]> {
  if (job.kind !== 'file' || job.resourceIds.length !== 1 || job.gateways.length !== 1) {
    throw new SGFileGatewayError(409, 'sg_deletion_target_invalid');
  }
  const lease = await methods.claimResourceDeletion(job.userId, job._id);
  if (!lease?.leaseToken) {
    const current = await methods.getResourceDeletion(job.userId, job._id);
    if (current?.state === 'complete' && current.remoteComplete) {
      await purgeFileDeletion(current, methods);
      return current.fileIds;
    }
    throw new SGFileGatewayError(409, 'sg_deletion_in_progress');
  }
  const token = lease.leaseToken;
  const fileId = lease.resourceIds[0];
  const gateway = lease.gateways[0];
  try {
    let fileIds = lease.fileIds;
    let requestIds = lease.requestMessageIds;
    if (!lease.remoteComplete) {
      const config = await configuration();
      if (!config.endpointConfig || config.endpointConfig.name !== gateway.endpoint) {
        throw new SGFileGatewayError(503, 'sg_file_endpoint_unavailable');
      }
      const report = await deleteSGGatewayScopedFileTree({
        endpointConfig: config.endpointConfig,
        allowedAddresses: config.allowedAddresses,
        userId: lease.userId,
        tenantId: lease.tenantId,
        conversationId: gateway.conversationId,
        fileId,
      });
      fileIds = [...new Set([...fileIds, ...report.deleted_file_ids])];
      requestIds = [...new Set([...requestIds, ...report.request_message_ids])];
      if (
        !(await methods.recordResourceDeletionTargets(
          lease.userId,
          lease._id,
          token,
          fileIds,
          requestIds,
        ))
      ) {
        throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
      }
    }
    const descendants = await discoverSGFileDescendants(
      { ...lease, fileIds, requestMessageIds: requestIds },
      methods,
    );
    if (descendants.length !== fileIds.length) {
      if (
        !(await methods.recordResourceDeletionTargets(
          lease.userId,
          lease._id,
          token,
          descendants,
          requestIds,
        ))
      ) {
        throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
      }
      fileIds = descendants;
    }
    await purgeFileDeletion({ ...lease, fileIds, requestMessageIds: requestIds }, methods);
    if (!(await methods.finishResourceDeletion(lease.userId, lease._id, token))) {
      throw new SGFileGatewayError(409, 'sg_deletion_lease_lost');
    }
    return fileIds;
  } catch (error) {
    await methods
      .releaseResourceDeletion(lease.userId, lease._id, token, 'cleanup_failed')
      .catch(() => false);
    throw error;
  }
}

export async function deleteSGFileResources(
  args: Parameters<typeof deleteSGGatewayFileTree>[0] & { methods: SGFileDeletionMethods },
): Promise<string[]> {
  const scope = args.file.metadata?.sgGateway;
  if (!scope?.conversationId || !scope.endpoint)
    throw new SGFileGatewayError(409, 'sg_file_metadata_missing');
  const job = await args.methods.beginResourceDeletion(args.userId, {
    kind: 'file',
    resourceIds: [args.file.file_id],
    gateways: [{ endpoint: args.endpointConfig.name, conversationId: scope.conversationId }],
  });
  return resumeSGFileDeletion({
    job,
    methods: args.methods,
    configuration: async () => ({
      endpointConfig: args.endpointConfig,
      allowedAddresses: args.allowedAddresses,
    }),
  });
}

type LifecycleMethods = Pick<FileMethods, 'getFiles' | 'deleteOwnedFiles'> &
  Pick<MessageMethods, 'getMessages'> &
  Pick<ConversationMethods, 'getConversationsForDeletion'>;

export function resolveSGDeletionEndpoint(
  endpoint: string,
  appConfig?: AppConfig,
): SGEndpointConfig | undefined {
  const config = getCustomEndpointConfig({ endpoint, appConfig });
  if (!isSGFileGatewayEndpoint(config)) return undefined;
  return {
    ...config,
    apiKey: extractEnvVariable(config.apiKey),
    baseURL: extractEnvVariable(config.baseURL),
  };
}

function referencedFiles(messages: Pick<IMessage, 'files' | 'metadata'>[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (
        file &&
        typeof file === 'object' &&
        'file_id' in file &&
        typeof file.file_id === 'string'
      ) {
        ids.add(file.file_id);
      }
    }
    const artifacts = sgArtifactMetadataSchema.safeParse(message.metadata?.sgArtifacts);
    if (artifacts.success) {
      for (const artifact of artifacts.data.artifacts) {
        ids.add(artifact.file_id);
        if (artifact.source_file_id) ids.add(artifact.source_file_id);
      }
    }
  }
  return ids;
}

/** Conversation IDs must come from the owner's database deletion selection, never request metadata. */
export async function deleteSGConversationResources({
  userId,
  tenantId,
  conversationIds,
  appConfig,
  methods,
}: {
  userId: string;
  tenantId?: string | null;
  conversationIds: string[];
  appConfig?: AppConfig;
  methods: LifecycleMethods;
}): Promise<void> {
  const plan = await planSGConversationDeletion({ userId, conversationIds, appConfig, methods });
  for (const gateway of plan.gateways) {
    const endpointConfig = resolveSGDeletionEndpoint(gateway.endpoint, appConfig);
    if (!endpointConfig) throw new SGFileGatewayError(503, 'sg_file_endpoint_unavailable');
    await deleteSGGatewayConversation({
      endpointConfig,
      conversationId: gateway.conversationId,
      userId,
      tenantId,
      allowedAddresses: appConfig?.endpoints?.allowedAddresses,
    });
  }
  if (plan.fileIds.length) await methods.deleteOwnedFiles(plan.fileIds, { userId, tenantId });
}

export async function planSGConversationDeletion({
  userId,
  conversationIds,
  appConfig,
  methods,
}: {
  userId: string;
  conversationIds: string[];
  appConfig?: AppConfig;
  methods: LifecycleMethods;
}): Promise<ResourceDeletionTarget & { fileIds: string[] }> {
  if (!conversationIds.length)
    return { kind: 'conversation', resourceIds: [], gateways: [], fileIds: [] };
  const selected = new Set(conversationIds);
  const messages = await methods.getMessages(
    { user: userId, conversationId: { $in: conversationIds } },
    'files metadata',
    { sort: false, includeDeleted: true },
  );
  const references = referencedFiles(messages ?? []);
  const files =
    (await methods.getFiles(
      {
        user: userId,
        source: FileSources.sg_gateway,
        $or: [
          { conversationId: { $in: conversationIds } },
          { 'metadata.sgGateway.conversationId': { $in: conversationIds } },
          { file_id: { $in: [...references] } },
        ],
      },
      undefined,
      undefined,
      { includeDeleted: true },
    )) ?? [];
  const endpoints = new Map<string, SGEndpointConfig>();
  const liveConversations = files.some((file) =>
    file.metadata?.sgGateway?.conversationId.startsWith('draft-'),
  )
    ? new Set(await methods.getConversationsForDeletion(userId))
    : new Set<string>();
  for (const endpoint of appConfig?.endpoints?.[EModelEndpoint.custom] ?? []) {
    if (!isSGFileGatewayEndpoint(endpoint)) continue;
    const resolved = resolveSGDeletionEndpoint(endpoint.name, appConfig);
    if (resolved) endpoints.set(endpoint.name, resolved);
  }
  const eligible = files.filter((file) => {
    if (String(file.user) !== userId) throw new SGFileGatewayError(403, 'sg_file_owner_mismatch');
    const gateway = file.metadata?.sgGateway;
    if (file.source !== FileSources.sg_gateway) return false;
    if (
      file.conversationId &&
      !file.conversationId.startsWith('draft-') &&
      !selected.has(file.conversationId) &&
      (!gateway?.conversationId.startsWith('draft-') || liveConversations.has(file.conversationId))
    )
      return false;
    if (!gateway?.endpoint || !gateway.conversationId) {
      throw new SGFileGatewayError(409, 'sg_file_metadata_missing');
    }
    if (!selected.has(gateway.conversationId) && !gateway.conversationId.startsWith('draft-')) {
      if (file.conversationId && selected.has(file.conversationId)) {
        throw new SGFileGatewayError(409, 'sg_file_scope_mismatch');
      }
      return false;
    }
    if (!endpoints.has(gateway.endpoint)) {
      const resolved = resolveSGDeletionEndpoint(gateway.endpoint, appConfig);
      if (!resolved) throw new SGFileGatewayError(409, 'sg_file_endpoint_unavailable');
      endpoints.set(gateway.endpoint, resolved);
    }
    return true;
  });
  const legacyGroups = new Map(
    eligible.flatMap((file) => {
      const gateway = file.metadata!.sgGateway!;
      return gateway.conversationId.startsWith('draft-')
        ? [[JSON.stringify([gateway.endpoint, gateway.conversationId]), gateway] as const]
        : [];
    }),
  );
  const legacyFiles = legacyGroups.size
    ? (
        (await methods.getFiles(
          {
            user: userId,
            source: FileSources.sg_gateway,
            'metadata.sgGateway.conversationId': {
              $in: [...legacyGroups.values()].map((group) => group.conversationId),
            },
          },
          undefined,
          undefined,
          { includeDeleted: true },
        )) ?? []
      ).filter((file) => {
        const gateway = file.metadata?.sgGateway;
        return (
          gateway && legacyGroups.has(JSON.stringify([gateway.endpoint, gateway.conversationId]))
        );
      })
    : [];
  const legacyIds = legacyFiles.map((file) => file.file_id);
  const foreignReferences = legacyIds.length
    ? referencedFiles(
        await methods.getMessages(
          {
            user: userId,
            conversationId: { $nin: conversationIds },
            $or: [
              { 'files.file_id': { $in: legacyIds } },
              { 'metadata.sgArtifacts.artifacts.file_id': { $in: legacyIds } },
              { 'metadata.sgArtifacts.artifacts.source_file_id': { $in: legacyIds } },
            ],
          },
          'files metadata',
          { sort: false, includeDeleted: true },
        ),
      )
    : new Set<string>();
  const protectedGroups = new Set<string>();
  for (const file of legacyFiles) {
    if (String(file.user) !== userId) throw new SGFileGatewayError(403, 'sg_file_owner_mismatch');
    if (
      foreignReferences.has(file.file_id) ||
      (file.conversationId &&
        !file.conversationId.startsWith('draft-') &&
        !selected.has(file.conversationId) &&
        liveConversations.has(file.conversationId))
    ) {
      protectedGroups.add(
        JSON.stringify([
          file.metadata!.sgGateway!.endpoint,
          file.metadata!.sgGateway!.conversationId,
        ]),
      );
    }
  }
  const removed = [
    ...eligible.filter((file) => !file.metadata!.sgGateway!.conversationId.startsWith('draft-')),
    ...legacyFiles.filter(
      (file) =>
        !protectedGroups.has(
          JSON.stringify([
            file.metadata!.sgGateway!.endpoint,
            file.metadata!.sgGateway!.conversationId,
          ]),
        ),
    ),
  ];
  return {
    kind: 'conversation',
    resourceIds: conversationIds,
    protectedFileIds: legacyFiles
      .filter((file) =>
        protectedGroups.has(
          JSON.stringify([
            file.metadata!.sgGateway!.endpoint,
            file.metadata!.sgGateway!.conversationId,
          ]),
        ),
      )
      .map((file) => file.file_id),
    fileIds: [...new Set(removed.map((file) => file.file_id))],
    gateways: [
      ...[...endpoints.keys()].flatMap((endpoint) =>
        conversationIds.map((conversationId) => ({ endpoint, conversationId })),
      ),
      ...[...legacyGroups]
        .filter(([key]) => !protectedGroups.has(key))
        .map(([, gateway]) => ({
          endpoint: gateway.endpoint,
          conversationId: gateway.conversationId,
        })),
    ],
  };
}
