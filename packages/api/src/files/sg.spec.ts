import * as fs from 'fs';
import axios from 'axios';
import { FileSources } from 'librechat-data-provider';
import type { TEndpoint, TFile } from 'librechat-data-provider';
import {
  SGFileGatewayError,
  buildSGInternalContext,
  downloadSGGatewayCitationFile,
  deleteSGGatewayConversation,
  deleteSGGatewayFile,
  getSGGatewayImage,
  getSGGatewayCitationPage,
  getSGGatewayFileStatus,
  retrySGGatewayFile,
  toSGScopeToken,
  uploadSGGatewayFile,
} from './sg';

jest.mock('axios');
jest.mock('~/utils/axios', () => ({
  createAxiosInstance: () => jest.requireMock('axios'),
}));
jest.mock('~/auth/agent', () => ({ applySSRFSafeAgentIfDirect: jest.fn() }));
jest.mock('~/utils/proxy', () => ({ applyAxiosProxyConfig: jest.fn() }));

const mockAxios = jest.mocked(axios);

const endpointConfig = {
  name: 'SG AI Gateway',
  apiKey: 'gateway-test-key',
  baseURL: 'http://gateway.invalid:4000/v1',
  models: { default: ['default'] },
  customParams: { defaultParamsEndpoint: 'custom', sgFileGateway: true },
} satisfies TEndpoint;

const uploadFile: Express.Multer.File = {
  fieldname: 'file',
  originalname: 'policy.txt',
  encoding: '7bit',
  mimetype: 'text/plain',
  size: 6,
  destination: '',
  filename: 'policy.txt',
  path: __filename,
  buffer: Buffer.alloc(0),
  stream: fs.createReadStream(__filename),
};

describe('SG file gateway adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    uploadFile.stream.destroy();
  });

  it('streams an upload and maps the gateway reference without exposing storage paths', async () => {
    mockAxios.post.mockResolvedValue({
      status: 201,
      data: {
        file_id: 'file_0123456789abcdef0123456789abcdef',
        job_id: 'job_0123456789abcdef0123456789abcdef',
        display_name: 'policy.txt',
        mime_type: 'text/plain',
        size_bytes: 6,
        sha256: 'digest',
        state: 'UPLOADED',
        created_at: '2026-08-31T00:00:00+00:00',
      },
    });

    const result = await uploadSGGatewayFile({
      endpointConfig,
      file: uploadFile,
      tenantId: 'tenant-a',
      userId: 'user-a',
      conversationId: 'conversation-a',
      idempotencyKey: 'upload-a',
    });

    expect(result).toMatchObject({
      file_id: 'file_0123456789abcdef0123456789abcdef',
      temp_file_id: 'upload-a',
      filepath: '',
      source: FileSources.sg_gateway,
      status: 'pending',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_0123456789abcdef0123456789abcdef',
          conversationId: 'conversation-a',
          state: 'UPLOADED',
        },
      },
    });
    const [, , requestConfig] = mockAxios.post.mock.calls[0];
    expect(requestConfig?.headers).toMatchObject({
      Authorization: 'Bearer gateway-test-key',
      'X-SG-Tenant-ID': 'tenant-a',
      'X-SG-User-ID': 'user-a',
      'Idempotency-Key': 'upload-a',
    });
  });

  it('maps persisted READY status to the existing file lifecycle shape', async () => {
    mockAxios.request.mockResolvedValue({
      status: 200,
      data: {
        job_id: 'job_0123456789abcdef0123456789abcdef',
        file_id: 'file_0123456789abcdef0123456789abcdef',
        state: 'READY',
        attempt_count: 1,
        retryable: false,
        error_code: null,
        created_at: '2026-08-31T00:00:00+00:00',
        updated_at: '2026-08-31T00:00:01+00:00',
        ready_at: '2026-08-31T00:00:01+00:00',
        failed_at: null,
      },
    });
    const file = {
      file_id: 'file_0123456789abcdef0123456789abcdef',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_0123456789abcdef0123456789abcdef',
          conversationId: 'conversation-a',
          state: 'PROCESSING' as const,
        },
      },
    };

    const result = await getSGGatewayFileStatus({
      endpointConfig,
      file,
      tenantId: 'tenant-a',
      userId: 'user-a',
    });

    expect(result.status).toBe('ready');
    expect(result.metadata?.sgGateway?.state).toBe('READY');
  });

  it('maps image uploads to the authenticated LibreChat proxy and fetches normalized PNG', async () => {
    const fileId = 'file_0123456789abcdef0123456789abcdef';
    mockAxios.post.mockResolvedValue({
      status: 201,
      data: {
        file_id: fileId,
        job_id: 'job_0123456789abcdef0123456789abcdef',
        display_name: 'document.png',
        mime_type: 'image/png',
        size_bytes: 100,
        sha256: 'digest',
        state: 'READY',
        created_at: '2026-08-31T00:00:00+00:00',
      },
    });
    const uploaded = await uploadSGGatewayFile({
      endpointConfig,
      file: { ...uploadFile, originalname: 'document.png', mimetype: 'image/png' },
      userId: 'user-a',
      conversationId: 'conversation-a',
      idempotencyKey: 'upload-image',
    });
    expect(uploaded.filepath).toBe(`/api/files/sg-image/${fileId}`);

    const content = Buffer.from('normalized-png');
    mockAxios.request.mockResolvedValue({ status: 200, data: content });

    await expect(
      getSGGatewayImage({
        endpointConfig,
        file: uploaded,
        userId: 'user-a',
      }),
    ).resolves.toEqual(content);
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: `http://gateway.invalid:4000/internal/files/${fileId}/image`,
        responseType: 'arraybuffer',
      }),
    );
  });

  it('maps retry back to pending and treats an already-deleted file as success', async () => {
    const file = {
      file_id: 'file_0123456789abcdef0123456789abcdef',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_0123456789abcdef0123456789abcdef',
          conversationId: 'conversation-a',
          state: 'FAILED' as const,
        },
      },
    };
    mockAxios.request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          job_id: 'job_0123456789abcdef0123456789abcdef',
          file_id: 'file_0123456789abcdef0123456789abcdef',
          state: 'UPLOADED',
          attempt_count: 1,
          retryable: false,
          error_code: null,
          created_at: '2026-08-31T00:00:00+00:00',
          updated_at: '2026-08-31T00:00:01+00:00',
          ready_at: null,
          failed_at: null,
        },
      })
      .mockResolvedValueOnce({
        status: 404,
        data: { error: { code: 'resource_not_found' } },
      });

    const retried = await retrySGGatewayFile({
      endpointConfig,
      file,
      userId: 'user-a',
    });
    await expect(
      deleteSGGatewayFile({ endpointConfig, file, userId: 'user-a' }),
    ).resolves.toBeUndefined();

    expect(retried.status).toBe('pending');
  });

  it('fetches citation pages and originals with the persisted conversation scope', async () => {
    const fileId = 'file_0123456789abcdef0123456789abcdef';
    const file = {
      file_id: fileId,
      type: 'application/pdf',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_0123456789abcdef0123456789abcdef',
          conversationId: 'conversation-a',
          state: 'READY' as const,
        },
      },
    };
    mockAxios.request.mockResolvedValue({ status: 200, data: Buffer.from('content') });

    await getSGGatewayCitationPage({
      endpointConfig,
      file,
      pageNumber: 3,
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    await downloadSGGatewayCitationFile({
      endpointConfig,
      file,
      tenantId: 'tenant-a',
      userId: 'user-a',
    });

    expect(mockAxios.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: `http://gateway.invalid:4000/internal/files/${fileId}/pages/3`,
        responseType: 'arraybuffer',
        headers: expect.objectContaining({
          'X-SG-Conversation-ID': 'conversation-a',
        }),
      }),
    );
    expect(mockAxios.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: `http://gateway.invalid:4000/internal/files/${fileId}/download`,
        responseType: 'arraybuffer',
      }),
    );
  });

  it('deletes an owner-scoped gateway conversation with matching scope headers', async () => {
    mockAxios.request.mockResolvedValue({ status: 204, data: undefined });

    await deleteSGGatewayConversation({
      endpointConfig,
      conversationId: 'conversation-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
    });

    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: 'http://gateway.invalid:4000/internal/conversations/conversation-a',
        headers: expect.objectContaining({
          'X-SG-Tenant-ID': 'tenant-a',
          'X-SG-User-ID': 'user-a',
          'X-SG-Conversation-ID': 'conversation-a',
        }),
      }),
    );
  });

  it('builds trusted chat metadata only from authorized same-scope gateway files', () => {
    const gatewayFile = {
      file_id: 'file_0123456789abcdef0123456789abcdef',
      source: FileSources.sg_gateway,
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_0123456789abcdef0123456789abcdef',
          conversationId: 'conversation-a',
          state: 'READY' as const,
        },
      },
    } satisfies Pick<TFile, 'file_id' | 'source' | 'metadata'>;

    const context = buildSGInternalContext({
      requestFiles: [{ file_id: gatewayFile.file_id }],
      authorizedFiles: [gatewayFile],
      tenantId: 'tenant-a',
      userId: 'user-a',
      messageId: 'message-a',
      endpoint: 'SG AI Gateway',
    });

    expect(context).toEqual({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      conversation_id: 'conversation-a',
      message_id: 'message-a',
      file_ids: [gatewayFile.file_id],
    });
  });

  it('rejects a crafted or mixed local file reference', () => {
    expect(() =>
      buildSGInternalContext({
        requestFiles: [{ file_id: 'local-file' }],
        authorizedFiles: [],
        userId: 'user-a',
        messageId: 'message-a',
        endpoint: 'SG AI Gateway',
      }),
    ).toThrow(SGFileGatewayError);
  });

  it('hashes identifiers that are not valid bounded scope tokens', () => {
    expect(toSGScopeToken('user with spaces', 'user')).toMatch(/^user-[0-9a-f]{32}$/);
  });
});
