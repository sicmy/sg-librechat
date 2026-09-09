import * as fs from 'fs';
import * as crypto from 'crypto';
import FormData from 'form-data';
import {
  FileContext,
  FileSources,
  sgArtifactMetadataSchema,
  sgFileDeletionReportSchema,
} from 'librechat-data-provider';
import type { SGFileDeletionReport } from 'librechat-data-provider';
import type {
  SGFileMetadata,
  SGArtifactMetadata,
  SGFileState,
  TEndpoint,
  TFile,
  TFileUpload,
  TMessage,
} from 'librechat-data-provider';
import type { RetentionExpiry } from './retention';
import type { AxiosRequestConfig } from 'axios';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_TIMEOUT_MS = 120_000;

export type SGEndpointConfig = Pick<TEndpoint, 'name' | 'apiKey' | 'baseURL' | 'customParams'>;

type GatewayUploadResponse = {
  file_id: string;
  job_id: string;
  display_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  state: SGFileState;
  created_at: string;
};

type GatewayJobResponse = {
  job_id: string;
  file_id: string;
  state: SGFileState;
  attempt_count: number;
  retryable: boolean;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  failed_at: string | null;
};

export type SGInternalContext = {
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  file_ids: string[];
};

export class SGFileGatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function isSGFileGatewayEndpoint(
  endpointConfig: Partial<TEndpoint> | undefined,
): endpointConfig is SGEndpointConfig {
  return endpointConfig?.customParams?.sgFileGateway === true;
}

export function toSGScopeToken(value: string | null | undefined, prefix: string): string {
  const candidate = value?.trim() ?? '';
  if (TOKEN_PATTERN.test(candidate)) {
    return candidate;
  }
  const digest = crypto
    .createHash('sha256')
    .update(candidate || prefix)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

export function getSGGatewayFilePath(fileId: string, mimeType: string | undefined): string {
  return mimeType?.startsWith('image/') === true
    ? `/api/files/sg-image/${encodeURIComponent(fileId)}`
    : '';
}

export async function uploadSGGatewayFile({
  endpointConfig,
  file,
  tenantId,
  userId,
  conversationId,
  idempotencyKey,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Express.Multer.File;
  tenantId?: string | null;
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  allowedAddresses?: string[] | null;
}): Promise<TFileUpload> {
  const form = new FormData();
  const fileStream = fs.createReadStream(file.path);
  form.append('file', fileStream, {
    filename: file.originalname,
    contentType: file.mimetype,
    knownLength: file.size,
  });
  const scope = {
    tenantId: toSGScopeToken(tenantId, 'tenant'),
    userId: toSGScopeToken(userId, 'user'),
    conversationId: requireScopeToken(conversationId, 'conversation_id'),
  };
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/conversations/${encodeURIComponent(scope.conversationId)}/files`,
  );
  const config: AxiosRequestConfig = {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${endpointConfig.apiKey}`,
      'X-SG-Tenant-ID': scope.tenantId,
      'X-SG-User-ID': scope.userId,
      'Idempotency-Key': requireScopeToken(idempotencyKey, 'idempotency_key'),
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  };
  applyAxiosProxyConfig(config, url);
  applySSRFSafeAgentIfDirect(config, url, allowedAddresses);

  try {
    const response = await axios.post<GatewayUploadResponse>(url, form, config);
    if (response.status !== 200 && response.status !== 201) {
      throw gatewayResponseError(response.status, response.data);
    }
    const upload = requireUploadResponse(response.data);
    const metadata = toSGFileMetadata(upload, endpointConfig.name, scope.conversationId);
    return {
      user: userId,
      ...(tenantId ? { tenantId } : {}),
      conversationId: scope.conversationId,
      file_id: upload.file_id,
      temp_file_id: idempotencyKey,
      bytes: upload.size_bytes,
      embedded: false,
      filename: upload.display_name,
      filepath: getSGGatewayFilePath(upload.file_id, upload.mime_type),
      object: 'file',
      type: upload.mime_type,
      usage: 0,
      context: FileContext.message_attachment,
      source: FileSources.sg_gateway,
      status: toClientStatus(upload.state),
      metadata: { sgGateway: metadata },
    };
  } catch (error) {
    if (error instanceof SGFileGatewayError) {
      throw error;
    }
    throw new SGFileGatewayError(502, 'sg_file_gateway_unavailable');
  } finally {
    fileStream.destroy();
  }
}

export async function getSGGatewayImage({
  endpointConfig,
  file,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'type' | 'metadata'>;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<Buffer> {
  if (!file.type?.startsWith('image/')) {
    throw new SGFileGatewayError(404, 'resource_not_found');
  }
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/files/${encodeURIComponent(file.file_id)}/image`,
  );
  return requestGateway<Buffer>({
    method: 'GET',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
    responseType: 'arraybuffer',
  });
}

export async function getSGGatewayCitationPage({
  endpointConfig,
  file,
  pageNumber,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'type' | 'metadata'>;
  pageNumber: number;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<Buffer> {
  if (file.type !== 'application/pdf' || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new SGFileGatewayError(404, 'resource_not_found');
  }
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/files/${encodeURIComponent(file.file_id)}/pages/${pageNumber}`,
  );
  return requestGateway<Buffer>({
    method: 'GET',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
    responseType: 'arraybuffer',
  });
}

export async function getSGGatewayCitationFrame({
  endpointConfig,
  file,
  frameNumber,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'type' | 'metadata'>;
  frameNumber: number;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<Buffer> {
  if (!file.type?.startsWith('video/') || !Number.isSafeInteger(frameNumber) || frameNumber < 0) {
    throw new SGFileGatewayError(404, 'resource_not_found');
  }
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/files/${encodeURIComponent(file.file_id)}/frames/${frameNumber}`,
  );
  return requestGateway<Buffer>({
    method: 'GET',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
    responseType: 'arraybuffer',
  });
}

export async function downloadSGGatewayCitationFile({
  endpointConfig,
  file,
  tenantId,
  userId,
  allowedAddresses,
  documentPreview = false,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'metadata'>;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
  documentPreview?: boolean;
}): Promise<Buffer> {
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/files/${encodeURIComponent(file.file_id)}/${documentPreview ? 'document-preview' : 'download'}`,
  );
  return requestGateway<Buffer>({
    method: 'GET',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
    responseType: 'arraybuffer',
  });
}

export async function getSGGatewayFileStatus({
  endpointConfig,
  file,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'metadata'>;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<Pick<TFile, 'file_id' | 'status' | 'previewError' | 'metadata'>> {
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/jobs/${encodeURIComponent(gateway.jobId)}`,
  );
  const response = await requestGateway<GatewayJobResponse>({
    method: 'GET',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
  });
  const status = requireJobResponse(response);
  return {
    file_id: file.file_id,
    status: toClientStatus(status.state),
    ...(status.error_code ? { previewError: status.error_code } : {}),
    metadata: {
      sgGateway: {
        endpoint: gateway.endpoint,
        jobId: status.job_id,
        conversationId: gateway.conversationId,
        state: status.state,
        retryable: status.retryable,
        errorCode: status.error_code,
      },
    },
  };
}

export function retrySGGatewayFile(
  args: Omit<Parameters<typeof changeSGGatewayFileJob>[0], 'action'>,
): ReturnType<typeof changeSGGatewayFileJob> {
  return changeSGGatewayFileJob({ ...args, action: 'retry' });
}

export function cancelSGGatewayFile(
  args: Omit<Parameters<typeof changeSGGatewayFileJob>[0], 'action'>,
): ReturnType<typeof changeSGGatewayFileJob> {
  return changeSGGatewayFileJob({ ...args, action: 'cancel' });
}

async function changeSGGatewayFileJob({
  endpointConfig,
  file,
  tenantId,
  userId,
  allowedAddresses,
  action,
}: {
  action: 'retry' | 'cancel';
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'metadata'>;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<Pick<TFile, 'file_id' | 'status' | 'previewError' | 'metadata'>> {
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/jobs/${encodeURIComponent(gateway.jobId)}/${action}`,
  );
  const response = await requestGateway<GatewayJobResponse>({
    method: 'POST',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId: gateway.conversationId,
    allowedAddresses,
  });
  const status = requireJobResponse(response);
  return {
    file_id: file.file_id,
    status: toClientStatus(status.state),
    ...(status.error_code ? { previewError: status.error_code } : {}),
    metadata: {
      sgGateway: {
        endpoint: gateway.endpoint,
        jobId: status.job_id,
        conversationId: gateway.conversationId,
        state: status.state,
        retryable: status.retryable,
        errorCode: status.error_code,
      },
    },
  };
}

export async function deleteSGGatewayFile({
  endpointConfig,
  file,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  file: Pick<TFile, 'file_id' | 'metadata'>;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<void> {
  const gateway = requireGatewayMetadata(file);
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/files/${encodeURIComponent(file.file_id)}`,
  );
  try {
    await requestGateway<undefined>({
      method: 'DELETE',
      url,
      endpointConfig,
      tenantId,
      userId,
      conversationId: gateway.conversationId,
      allowedAddresses,
    });
  } catch (error) {
    if (error instanceof SGFileGatewayError && error.code === 'resource_not_found') {
      return;
    }
    throw error;
  }
}

export async function deleteSGGatewayFileTree(
  args: Parameters<typeof deleteSGGatewayFile>[0],
): Promise<SGFileDeletionReport> {
  const gateway = requireGatewayMetadata(args.file);
  return deleteSGGatewayScopedFileTree({
    ...args,
    fileId: args.file.file_id,
    conversationId: gateway.conversationId,
  });
}

export async function deleteSGGatewayScopedFileTree(args: {
  fileId: string;
  conversationId: string;
  endpointConfig: SGEndpointConfig;
  userId: string;
  tenantId?: string | null;
  allowedAddresses?: string[] | null;
}): Promise<SGFileDeletionReport> {
  requireScopeToken(args.fileId, 'file_id');
  requireScopeToken(args.conversationId, 'conversation_id');
  const url = new URL(
    getGatewayURL(
      args.endpointConfig.baseURL,
      `/internal/files/${encodeURIComponent(args.fileId)}`,
    ),
  );
  url.searchParams.set('report', 'true');
  const response = await requestGateway<SGFileDeletionReport>({
    ...args,
    method: 'DELETE',
    url: url.toString(),
    conversationId: args.conversationId,
  });
  const parsed = sgFileDeletionReportSchema.safeParse(response);
  if (
    !parsed.success ||
    parsed.data.file_id !== args.fileId ||
    parsed.data.conversation_id !== args.conversationId
  ) {
    throw new SGFileGatewayError(502, 'sg_file_deletion_report_invalid');
  }
  return parsed.data;
}

export async function deleteSGGatewayConversation({
  endpointConfig,
  conversationId,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  conversationId: string;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<void> {
  const url = getGatewayURL(
    endpointConfig.baseURL,
    `/internal/conversations/${encodeURIComponent(conversationId)}`,
  );
  await requestGateway<undefined>({
    method: 'DELETE',
    url,
    endpointConfig,
    tenantId,
    userId,
    conversationId,
    allowedAddresses,
  });
}

export function buildSGInternalContext({
  requestFiles,
  authorizedFiles,
  tenantId,
  userId,
  messageId,
  endpoint,
  conversationId,
}: {
  requestFiles: Array<{ file_id?: string }>;
  authorizedFiles: Array<Pick<TFile, 'file_id' | 'source' | 'metadata'>>;
  tenantId?: string | null;
  userId: string;
  messageId: string;
  endpoint: string;
  conversationId: string;
}): SGInternalContext | undefined {
  const fileIds = requestFiles.flatMap((file) => (file.file_id ? [file.file_id] : []));
  if (fileIds.length === 0) {
    return undefined;
  }
  const uniqueFileIds = [...new Set(fileIds)];
  if (uniqueFileIds.length > 32) {
    throw new SGFileGatewayError(400, 'sg_file_reference_limit');
  }
  const filesById = new Map(authorizedFiles.map((file) => [file.file_id, file]));
  const scopes = new Set<string>();
  for (const fileId of fileIds) {
    const file = filesById.get(fileId);
    if (
      !file ||
      file.source !== FileSources.sg_gateway ||
      file.metadata?.sgGateway?.endpoint !== endpoint
    ) {
      throw new SGFileGatewayError(404, 'sg_file_reference_not_found');
    }
    scopes.add(requireGatewayMetadata(file).conversationId);
  }
  if (scopes.size !== 1) {
    throw new SGFileGatewayError(409, 'sg_file_scope_conflict');
  }
  if (!scopes.has(requireScopeToken(conversationId, 'conversation_id'))) {
    throw new SGFileGatewayError(404, 'sg_file_reference_not_found');
  }
  return {
    tenant_id: toSGScopeToken(tenantId, 'tenant'),
    user_id: toSGScopeToken(userId, 'user'),
    conversation_id: conversationId,
    message_id: toSGScopeToken(messageId, 'message'),
    file_ids: uniqueFileIds,
  };
}

type ScopedSGFile = Pick<TFile, 'file_id' | 'source' | 'metadata' | 'conversationId'>;

export async function bindSGDraftFiles({
  files,
  fileIds,
  conversationId,
  endpointConfig,
  tenantId,
  userId,
  allowedAddresses,
  hasForeignReferences,
  updateFile,
}: {
  files: ScopedSGFile[];
  fileIds: string[];
  conversationId: string;
  endpointConfig: SGEndpointConfig;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
  hasForeignReferences: (fileIds: string[]) => Promise<boolean>;
  updateFile: (
    file: Partial<TFile> & { file_id: string },
    filter: { user: string },
  ) => Promise<object | null>;
}): Promise<ScopedSGFile[]> {
  requireScopeToken(conversationId, 'conversation_id');
  const byId = new Map(files.map((file) => [file.file_id, file]));
  const selected = fileIds.map((id) => {
    const file = byId.get(id);
    if (
      !file ||
      file.source !== FileSources.sg_gateway ||
      file.metadata?.sgGateway?.endpoint !== endpointConfig.name
    ) {
      throw new SGFileGatewayError(404, 'sg_file_reference_not_found');
    }
    return file;
  });
  const drafts = new Map<string, ScopedSGFile[]>();
  for (const file of selected) {
    const scope = requireGatewayMetadata(file).conversationId;
    if (scope === conversationId) {
      continue;
    }
    if (
      !scope.startsWith('draft-') ||
      (file.conversationId &&
        !file.conversationId.startsWith('draft-') &&
        file.conversationId !== conversationId)
    ) {
      throw new SGFileGatewayError(404, 'sg_file_reference_not_found');
    }
    drafts.set(scope, [...(drafts.get(scope) ?? []), file]);
  }
  const draftIds = Array.from(drafts.values()).flatMap((group) =>
    group.map((file) => file.file_id),
  );
  if (draftIds.length && (await hasForeignReferences(draftIds))) {
    throw new SGFileGatewayError(404, 'sg_file_reference_not_found');
  }
  for (const [draft, group] of drafts) {
    await requestGateway({
      method: 'POST',
      url: getGatewayURL(
        endpointConfig.baseURL,
        `/internal/conversations/${encodeURIComponent(draft)}/bind`,
      ),
      endpointConfig,
      tenantId,
      userId,
      conversationId: draft,
      allowedAddresses,
      data: { conversation_id: conversationId, file_ids: group.map((file) => file.file_id) },
    });
    for (const file of group) {
      const metadata = {
        ...file.metadata,
        sgGateway: { ...requireGatewayMetadata(file), conversationId },
      };
      if (
        !(await updateFile({ file_id: file.file_id, conversationId, metadata }, { user: userId }))
      ) {
        throw new SGFileGatewayError(409, 'sg_file_binding_interrupted');
      }
      byId.set(file.file_id, { ...file, conversationId, metadata });
    }
  }
  return fileIds.map((id) => byId.get(id)!);
}

export function extractSGArtifactMetadata(
  output:
    | {
        sg_artifacts?: object;
        additional_kwargs?: { __raw_response?: { sg_artifacts?: object } };
        response_metadata?: { sg_artifacts?: object };
      }
    | undefined,
): SGArtifactMetadata | null {
  for (const candidate of [
    output?.sg_artifacts,
    output?.additional_kwargs?.__raw_response?.sg_artifacts,
    output?.response_metadata?.sg_artifacts,
  ]) {
    const parsed = sgArtifactMetadataSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

export function selectSGEditFiles(
  text: string | undefined,
  requested: string[],
  messages: Pick<TMessage, 'messageId' | 'parentMessageId' | 'metadata'>[],
  parentId: string | undefined,
): string[] | undefined {
  if (!text || !/^(이미지 편집|그림 편집|Edit an image|Edit image)\s*:/i.test(text.trim())) {
    return undefined;
  }
  if (requested.length) {
    return requested;
  }
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const visited = new Set<string>();
  let currentId = parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = byId.get(currentId);
    if (!message) {
      break;
    }
    const parsed = sgArtifactMetadataSchema.safeParse(message.metadata?.sgArtifacts);
    if (parsed.success) {
      const images = parsed.data.artifacts.filter((artifact) => artifact.mime_type === 'image/png');
      if (images.length) {
        return images.map((artifact) => artifact.file_id);
      }
    }
    currentId = message.parentMessageId ?? undefined;
  }
  return undefined;
}

export async function getSGGenerationDelivery({
  endpointConfig,
  conversationId,
  messageId,
  tenantId,
  userId,
  allowedAddresses,
}: {
  endpointConfig: SGEndpointConfig;
  conversationId: string;
  messageId: string;
  tenantId?: string | null;
  userId: string;
  allowedAddresses?: string[] | null;
}): Promise<SGArtifactMetadata | null> {
  const scope = toSGScopeToken(conversationId, 'conversation');
  const requestId = toSGScopeToken(messageId, 'message');
  let response: {
    schema_version: number;
    state: 'PENDING' | 'READY';
    message_id: string;
    artifacts: SGArtifactMetadata['artifacts'];
  };
  try {
    response = await requestGateway({
      method: 'GET',
      url: getGatewayURL(
        endpointConfig.baseURL,
        `/internal/conversations/${encodeURIComponent(scope)}/generations/${encodeURIComponent(requestId)}`,
      ),
      endpointConfig,
      tenantId,
      userId,
      conversationId: scope,
      allowedAddresses,
      allowPending: true,
    });
  } catch (error) {
    if (error instanceof SGFileGatewayError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
  if (!response || response.message_id !== requestId || response.schema_version !== 1) {
    throw new SGFileGatewayError(502, 'sg_generation_delivery_invalid');
  }
  if (
    response.state === 'PENDING' &&
    Array.isArray(response.artifacts) &&
    response.artifacts.length === 0
  ) {
    return null;
  }
  const parsed = sgArtifactMetadataSchema.safeParse({
    schema_version: response.schema_version,
    artifacts: response.artifacts,
  });
  if (
    response.state !== 'READY' ||
    !parsed.success ||
    parsed.data.artifacts.some((artifact) => artifact.conversation_id !== scope)
  ) {
    throw new SGFileGatewayError(502, 'sg_generation_delivery_invalid');
  }
  return parsed.data;
}

export async function registerSGArtifacts({
  metadata,
  endpointConfig,
  scope,
  createFile,
  allowedAddresses,
  retention,
}: {
  metadata: SGArtifactMetadata;
  endpointConfig: SGEndpointConfig;
  scope: {
    tenantId?: string | null;
    userId: string;
    conversationId: string;
    gatewayConversationId: string;
    requestMessageId?: string;
  };
  createFile: (file: TFileUpload, disableTTL: boolean) => Promise<object | null>;
  allowedAddresses?: string[] | null;
  retention?: RetentionExpiry;
}): Promise<void> {
  for (const artifact of metadata.artifacts) {
    if (artifact.conversation_id !== scope.gatewayConversationId) {
      throw new SGFileGatewayError(404, 'resource_not_found');
    }
    const file: TFileUpload = {
      user: scope.userId,
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
      conversationId: scope.conversationId,
      file_id: artifact.file_id,
      temp_file_id: artifact.file_id,
      bytes: artifact.size_bytes,
      filename: artifact.display_name,
      filepath: getSGGatewayFilePath(artifact.file_id, artifact.mime_type),
      type: artifact.mime_type,
      embedded: false,
      object: 'file',
      usage: 0,
      source: FileSources.sg_gateway,
      context: FileContext.message_attachment,
      status: 'ready',
      ...(retention?.expiredAt !== undefined ? { expiredAt: retention.expiredAt } : {}),
      metadata: {
        sgGateway: {
          endpoint: endpointConfig.name,
          jobId: artifact.job_id,
          ...(artifact.source_file_id ? { sourceFileId: artifact.source_file_id } : {}),
          ...(scope.requestMessageId ? { requestMessageId: scope.requestMessageId } : {}),
          conversationId: artifact.conversation_id,
          state: 'READY',
        },
      },
    };
    const status = await getSGGatewayFileStatus({
      endpointConfig,
      file,
      tenantId: scope.tenantId,
      userId: scope.userId,
      allowedAddresses,
    });
    if (status.file_id !== artifact.file_id || status.status !== 'ready') {
      throw new SGFileGatewayError(409, 'sg_artifact_not_ready');
    }
    if (!(await createFile(file, true))) {
      throw new SGFileGatewayError(500, 'sg_artifact_persistence_failed');
    }
  }
}

function getGatewayURL(baseURL: string, path: string): string {
  const url = new URL(baseURL);
  const basePath = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.pathname = `${basePath}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function requireScopeToken(value: string, field: string): string {
  if (!TOKEN_PATTERN.test(value)) {
    throw new SGFileGatewayError(400, `invalid_${field}`);
  }
  return value;
}

function requireGatewayMetadata(file: Pick<TFile, 'metadata'>): SGFileMetadata {
  const metadata = file.metadata?.sgGateway;
  if (!metadata?.endpoint || !metadata.jobId || !metadata.conversationId) {
    throw new SGFileGatewayError(409, 'sg_file_metadata_missing');
  }
  return metadata;
}

function requireUploadResponse(value: GatewayUploadResponse): GatewayUploadResponse {
  if (
    !value ||
    !TOKEN_PATTERN.test(value.file_id) ||
    !TOKEN_PATTERN.test(value.job_id) ||
    typeof value.display_name !== 'string' ||
    typeof value.mime_type !== 'string' ||
    typeof value.size_bytes !== 'number'
  ) {
    throw new SGFileGatewayError(502, 'sg_file_gateway_invalid_response');
  }
  return value;
}

function requireJobResponse(value: GatewayJobResponse): GatewayJobResponse {
  if (!value || !TOKEN_PATTERN.test(value.file_id) || !TOKEN_PATTERN.test(value.job_id)) {
    throw new SGFileGatewayError(502, 'sg_file_gateway_invalid_response');
  }
  return value;
}

function toSGFileMetadata(
  response: GatewayUploadResponse,
  endpoint: string,
  conversationId: string,
): SGFileMetadata {
  return {
    endpoint,
    jobId: response.job_id,
    conversationId,
    state: response.state,
  };
}

function toClientStatus(state: SGFileState): 'pending' | 'ready' | 'failed' {
  if (state === 'READY') {
    return 'ready';
  }
  if (state === 'FAILED') {
    return 'failed';
  }
  return 'pending';
}

async function requestGateway<T>({
  method,
  url,
  endpointConfig,
  tenantId,
  userId,
  conversationId,
  allowedAddresses,
  responseType,
  data,
  allowPending = false,
}: {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  endpointConfig: SGEndpointConfig;
  tenantId?: string | null;
  userId: string;
  conversationId: string;
  allowedAddresses?: string[] | null;
  responseType?: AxiosRequestConfig['responseType'];
  data?: { conversation_id: string; file_ids: string[] };
  allowPending?: boolean;
}): Promise<T> {
  const config: AxiosRequestConfig = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${endpointConfig.apiKey}`,
      'X-SG-Tenant-ID': toSGScopeToken(tenantId, 'tenant'),
      'X-SG-User-ID': toSGScopeToken(userId, 'user'),
      'X-SG-Conversation-ID': requireScopeToken(conversationId, 'conversation_id'),
    },
    timeout: REQUEST_TIMEOUT_MS,
    ...(responseType ? { responseType } : {}),
    ...(data ? { data } : {}),
    validateStatus: () => true,
  };
  applyAxiosProxyConfig(config, url);
  applySSRFSafeAgentIfDirect(config, url, allowedAddresses);
  try {
    const response = await axios.request<T>(config);
    if (
      response.status !== 200 &&
      response.status !== 204 &&
      !(allowPending && response.status === 202)
    ) {
      throw gatewayResponseError(response.status, response.data);
    }
    return response.data;
  } catch (error) {
    if (error instanceof SGFileGatewayError) {
      throw error;
    }
    throw new SGFileGatewayError(502, 'sg_file_gateway_unavailable');
  }
}

function gatewayResponseError(status: number, data: unknown): SGFileGatewayError {
  const code =
    data &&
    typeof data === 'object' &&
    'error' in data &&
    data.error &&
    typeof data.error === 'object' &&
    'code' in data.error &&
    typeof data.error.code === 'string'
      ? data.error.code
      : 'sg_file_gateway_error';
  const publicStatus = status >= 400 && status < 600 ? status : 502;
  return new SGFileGatewayError(publicStatus, code);
}
