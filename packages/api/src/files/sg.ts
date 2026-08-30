import * as crypto from 'crypto';
import * as fs from 'fs';
import FormData from 'form-data';
import { FileContext, FileSources } from 'librechat-data-provider';
import type {
  SGFileMetadata,
  SGFileState,
  TEndpoint,
  TFile,
  TFileUpload,
} from 'librechat-data-provider';
import type { AxiosRequestConfig } from 'axios';
import { createAxiosInstance } from '~/utils/axios';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { applyAxiosProxyConfig } from '~/utils/proxy';

const axios = createAxiosInstance();
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_TIMEOUT_MS = 120_000;

type SGEndpointConfig = Pick<TEndpoint, 'name' | 'apiKey' | 'baseURL' | 'customParams'>;

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
      filepath: '',
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

export async function retrySGGatewayFile({
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
    `/internal/jobs/${encodeURIComponent(gateway.jobId)}/retry`,
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
}: {
  requestFiles: Array<{ file_id?: string }>;
  authorizedFiles: Array<Pick<TFile, 'file_id' | 'source' | 'metadata'>>;
  tenantId?: string | null;
  userId: string;
  messageId: string;
  endpoint: string;
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
  return {
    tenant_id: toSGScopeToken(tenantId, 'tenant'),
    user_id: toSGScopeToken(userId, 'user'),
    conversation_id: [...scopes][0],
    message_id: toSGScopeToken(messageId, 'message'),
    file_ids: uniqueFileIds,
  };
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
}: {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  endpointConfig: SGEndpointConfig;
  tenantId?: string | null;
  userId: string;
  conversationId: string;
  allowedAddresses?: string[] | null;
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
    validateStatus: () => true,
  };
  applyAxiosProxyConfig(config, url);
  applySSRFSafeAgentIfDirect(config, url, allowedAddresses);
  try {
    const response = await axios.request<T>(config);
    if (response.status !== 200 && response.status !== 204) {
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
