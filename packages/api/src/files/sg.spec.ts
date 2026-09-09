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
  deleteSGGatewayFileTree,
  getSGGatewayImage,
  getSGGatewayCitationPage,
  getSGGatewayCitationFrame,
  getSGGatewayFileStatus,
  getSGGenerationDelivery,
  retrySGGatewayFile,
  cancelSGGatewayFile,
  toSGScopeToken,
  uploadSGGatewayFile,
  registerSGArtifacts,
  extractSGArtifactMetadata,
  selectSGEditFiles,
  bindSGDraftFiles,
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
  it('requires a scoped complete deletion report before local cleanup', async () => {
    const file = {
      file_id: 'file_root',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          conversationId: 'conversation-a',
          jobId: 'job_root',
          state: 'READY' as const,
        },
      },
    };
    const report = {
      schema_version: 1,
      file_id: 'file_root',
      conversation_id: 'conversation-a',
      deleted_file_ids: ['file_root', 'file_child'],
      request_message_ids: ['message'],
    };
    mockAxios.request.mockResolvedValueOnce({ status: 200, data: report });
    expect(await deleteSGGatewayFileTree({ endpointConfig, file, userId: 'owner' })).toEqual(
      report,
    );
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: 'http://gateway.invalid:4000/internal/files/file_root?report=true',
      }),
    );
    mockAxios.request.mockResolvedValueOnce({
      status: 200,
      data: { ...report, conversation_id: 'other' },
    });
    await expect(
      deleteSGGatewayFileTree({ endpointConfig, file, userId: 'owner' }),
    ).rejects.toThrow('sg_file_deletion_report_invalid');
    mockAxios.request.mockResolvedValueOnce({ status: 204, data: undefined });
    await expect(
      deleteSGGatewayFileTree({ endpointConfig, file, userId: 'owner' }),
    ).rejects.toThrow('sg_file_deletion_report_invalid');
  });
  it('looks up completed generation without a POST and validates request/conversation scope', async () => {
    const artifact = {
      schema_version: 1,
      file_id: 'file_delivery',
      job_id: 'job_delivery',
      conversation_id: 'conversation-a',
      display_name: 'generated-image.png',
      mime_type: 'image/png',
      size_bytes: 100,
      sha256: 'a'.repeat(64),
      preview_path: '/internal/files/file_delivery/image',
      download_path: '/internal/files/file_delivery/download',
    };
    const args = {
      endpointConfig,
      conversationId: 'conversation-a',
      messageId: 'request-a',
      userId: 'user-a',
    };
    const delivery = {
      schema_version: 1,
      message_id: 'request-a',
      state: 'READY',
      artifacts: [artifact],
    };
    mockAxios.request.mockResolvedValueOnce({ status: 200, data: delivery });
    expect((await getSGGenerationDelivery(args))?.artifacts[0].file_id).toBe('file_delivery');
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://gateway.invalid:4000/internal/conversations/conversation-a/generations/request-a',
      }),
    );
    mockAxios.request.mockResolvedValueOnce({
      status: 200,
      data: { ...delivery, message_id: 'other-request' },
    });
    await expect(getSGGenerationDelivery(args)).rejects.toThrow('sg_generation_delivery_invalid');
    mockAxios.request.mockResolvedValueOnce({
      status: 200,
      data: { ...delivery, artifacts: [{ ...artifact, conversation_id: 'other-conversation' }] },
    });
    await expect(getSGGenerationDelivery(args)).rejects.toThrow('sg_generation_delivery_invalid');
  });

  it('does not treat pending or missing generation delivery as a completed artifact', async () => {
    const args = {
      endpointConfig,
      conversationId: 'conversation-a',
      messageId: 'request-a',
      userId: 'user-a',
    };
    mockAxios.request.mockResolvedValueOnce({
      status: 202,
      data: {
        schema_version: 1,
        message_id: 'request-a',
        state: 'PENDING',
        artifacts: [],
      },
    });
    expect(await getSGGenerationDelivery(args)).toBeNull();
    mockAxios.request.mockResolvedValueOnce({
      status: 404,
      data: { error: { code: 'resource_not_found' } },
    });
    expect(await getSGGenerationDelivery(args)).toBeNull();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    uploadFile.stream.destroy();
  });

  it('binds an unused draft to the real conversation before building file context', async () => {
    const file = {
      file_id: 'file_draft',
      source: FileSources.sg_gateway,
      conversationId: 'draft-a',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_draft',
          conversationId: 'draft-a',
          state: 'READY' as const,
        },
      },
    };
    mockAxios.request.mockResolvedValue({ status: 200, data: {} });
    const updateFile = jest.fn().mockResolvedValue({ file_id: file.file_id });
    const bound = await bindSGDraftFiles({
      files: [file],
      fileIds: [file.file_id],
      conversationId: 'conversation-a',
      endpointConfig,
      userId: 'user-a',
      hasForeignReferences: async () => false,
      updateFile,
    });
    expect(bound[0].metadata?.sgGateway?.conversationId).toBe('conversation-a');
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { conversation_id: 'conversation-a', file_ids: ['file_draft'] },
      }),
    );
    expect(() =>
      buildSGInternalContext({
        requestFiles: [{ file_id: file.file_id }],
        authorizedFiles: bound,
        userId: 'user-a',
        messageId: 'message-a',
        endpoint: 'SG AI Gateway',
        conversationId: 'conversation-b',
      }),
    ).toThrow('sg_file_reference_not_found');
  });

  it('rejects legacy drafts already referenced by another conversation before binding', async () => {
    const file = {
      file_id: 'file_draft',
      source: FileSources.sg_gateway,
      conversationId: 'draft-a',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_draft',
          conversationId: 'draft-a',
          state: 'READY' as const,
        },
      },
    };
    const updateFile = jest.fn();
    await expect(
      bindSGDraftFiles({
        files: [file],
        fileIds: [file.file_id],
        conversationId: 'conversation-b',
        endpointConfig,
        userId: 'user-a',
        hasForeignReferences: async () => true,
        updateFile,
      }),
    ).rejects.toThrow('sg_file_reference_not_found');
    expect(mockAxios.request).not.toHaveBeenCalled();
    expect(updateFile).not.toHaveBeenCalled();
  });

  it('selects edit sources from the active branch and gives new attachments priority', () => {
    const artifact = (file_id: string) => ({
      schema_version: 1 as const,
      file_id,
      job_id: 'job_generated',
      conversation_id: 'conversation-a',
      display_name: 'generated.png',
      mime_type: 'image/png' as const,
      size_bytes: 1000,
      sha256: 'a'.repeat(64),
      preview_path: `/internal/files/${file_id}/image`,
      download_path: `/internal/files/${file_id}/download`,
    });
    const messages = [
      {
        messageId: 'branch-a',
        parentMessageId: null,
        metadata: { sgArtifacts: { schema_version: 1 as const, artifacts: [artifact('file_a')] } },
      },
      {
        messageId: 'branch-b',
        parentMessageId: null,
        metadata: { sgArtifacts: { schema_version: 1 as const, artifacts: [artifact('file_b')] } },
      },
    ];
    expect(selectSGEditFiles('Edit image: Realistic', [], messages, 'branch-a')).toEqual([
      'file_a',
    ]);
    expect(selectSGEditFiles('Edit image: Realistic', ['file_new'], messages, 'branch-a')).toEqual([
      'file_new',
    ]);
    expect(selectSGEditFiles('Describe image editing', [], messages, 'branch-a')).toBeUndefined();
  });

  it('validates generated metadata and checks conversation scope before registration', async () => {
    const metadata = extractSGArtifactMetadata({
      sg_artifacts: {
        schema_version: 1,
        artifacts: [
          {
            schema_version: 1,
            file_id: 'file_generated',
            source_file_id: 'file_source',
            job_id: 'job_generated',
            conversation_id: 'conversation-a',
            display_name: 'generated-image.png',
            mime_type: 'image/png',
            size_bytes: 1000,
            sha256: 'a'.repeat(64),
            preview_path: '/internal/files/file_generated/image',
            download_path: '/internal/files/file_generated/download',
          },
        ],
      },
    });
    expect(metadata).not.toBeNull();
    const createFile = jest.fn().mockResolvedValue({ file_id: 'file_generated' });
    await expect(
      registerSGArtifacts({
        metadata: metadata!,
        endpointConfig,
        scope: {
          userId: 'user-a',
          conversationId: 'conversation-b',
          gatewayConversationId: 'conversation-b',
        },
        createFile,
      }),
    ).rejects.toThrow('resource_not_found');
    expect(mockAxios.request).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    mockAxios.request.mockResolvedValue({
      status: 200,
      data: { file_id: 'file_generated', job_id: 'job_generated', state: 'READY' },
    });
    await registerSGArtifacts({
      metadata: metadata!,
      endpointConfig,
      createFile,
      retention: { expiredAt: new Date('2030-01-01T00:00:00Z') },
      scope: {
        userId: 'user-a',
        conversationId: 'conversation-a',
        gatewayConversationId: 'conversation-a',
        requestMessageId: 'request-a',
      },
    });
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: new Date('2030-01-01T00:00:00Z'),
        metadata: {
          sgGateway: expect.objectContaining({
            sourceFileId: 'file_source',
            requestMessageId: 'request-a',
          }),
        },
      }),
      true,
    );
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

  it('cancels with persisted scope and preserves retryable cancellation metadata', async () => {
    const file = {
      file_id: 'file_cancel',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_cancel',
          conversationId: 'draft-owned',
          state: 'PROCESSING' as const,
        },
      },
    };
    mockAxios.request.mockResolvedValueOnce({
      status: 200,
      data: {
        file_id: file.file_id,
        job_id: 'job_cancel',
        state: 'FAILED',
        attempt_count: 1,
        retryable: true,
        error_code: 'job_cancelled',
        created_at: '2026-09-08T00:00:00Z',
        updated_at: '2026-09-08T00:00:01Z',
        ready_at: null,
        failed_at: '2026-09-08T00:00:01Z',
      },
    });
    const result = await cancelSGGatewayFile({
      endpointConfig,
      file,
      tenantId: 'tenant-a',
      userId: 'user-a',
    });
    expect(result.status).toBe('failed');
    expect(result.previewError).toBe('job_cancelled');
    expect(result.metadata?.sgGateway?.retryable).toBe(true);
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'http://gateway.invalid:4000/internal/jobs/job_cancel/cancel',
        headers: expect.objectContaining({
          'X-SG-Tenant-ID': 'tenant-a',
          'X-SG-User-ID': 'user-a',
          'X-SG-Conversation-ID': 'draft-owned',
        }),
      }),
    );
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

  it('fetches frame zero with persisted scope and rejects negative frame numbers', async () => {
    const file = {
      file_id: 'file_video',
      type: 'video/mp4',
      metadata: {
        sgGateway: {
          endpoint: 'SG AI Gateway',
          jobId: 'job_video',
          conversationId: 'conversation-a',
          state: 'READY' as const,
        },
      },
    };
    mockAxios.request.mockResolvedValue({ status: 200, data: Buffer.from('png') });
    await getSGGatewayCitationFrame({ endpointConfig, file, frameNumber: 0, userId: 'user-a' });
    expect(mockAxios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://gateway.invalid:4000/internal/files/file_video/frames/0',
        headers: expect.objectContaining({ 'X-SG-Conversation-ID': 'conversation-a' }),
      }),
    );
    await expect(
      getSGGatewayCitationFrame({ endpointConfig, file, frameNumber: -1, userId: 'user-a' }),
    ).rejects.toThrow('resource_not_found');
    expect(mockAxios.request).toHaveBeenCalledTimes(1);
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
      conversationId: 'conversation-a',
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
        conversationId: 'conversation-a',
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
