import { createElement } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecoilRoot } from 'recoil';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TFilePreview } from 'librechat-data-provider';
import { useRetrySGFileMutation, useUploadFileMutation } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      retryFileProcessing: jest.fn(),
      uploadFile: jest.fn(),
      uploadImage: jest.fn(),
    },
  };
});

jest.mock('../../Endpoints', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
}));

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RecoilRoot, null, children),
    );
  };

describe('useRetrySGFileMutation', () => {
  it('replaces an actively cached failed preview with the pending retry response', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fileId = 'file_retry_test';
    const queryKey = [QueryKeys.filePreview, fileId];
    const pending: TFilePreview = { file_id: fileId, status: 'pending' };
    queryClient.setQueryData<TFilePreview>(queryKey, {
      file_id: fileId,
      status: 'failed',
      previewError: 'deterministic_file_failure',
    });
    jest.mocked(dataService.retryFileProcessing).mockResolvedValue(pending);

    const { result } = renderHook(() => useRetrySGFileMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(fileId);
    });

    expect(queryClient.getQueryData(queryKey)).toEqual(pending);
  });
});

describe('useUploadFileMutation', () => {
  const uploaded = {
    file_id: 'file_uploaded',
    temp_file_id: 'temp-file',
    filename: 'document.png',
    filepath: '',
    type: 'image/png',
    bytes: 100,
    size: 100,
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(dataService.uploadFile).mockResolvedValue(uploaded);
    jest.mocked(dataService.uploadImage).mockResolvedValue(uploaded);
  });

  it('uses the general file route for SG Gateway images', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useUploadFileMutation(), {
      wrapper: createWrapper(queryClient),
    });
    const body = new FormData();
    body.set('endpoint', 'SG AI Gateway');
    body.set('width', '640');
    body.set('height', '480');
    body.set('sg_file_gateway', 'true');

    await act(async () => {
      await result.current.mutateAsync(body);
    });

    expect(dataService.uploadFile).toHaveBeenCalledWith(body, undefined, false);
    expect(dataService.uploadImage).not.toHaveBeenCalled();
  });

  it('keeps the image route for non-Gateway images', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useUploadFileMutation(), {
      wrapper: createWrapper(queryClient),
    });
    const body = new FormData();
    body.set('endpoint', 'openAI');
    body.set('width', '640');
    body.set('height', '480');

    await act(async () => {
      await result.current.mutateAsync(body);
    });

    expect(dataService.uploadImage).toHaveBeenCalledWith(body, undefined, false);
  });
});
