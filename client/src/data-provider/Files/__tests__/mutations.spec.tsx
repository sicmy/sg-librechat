import { createElement } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TFilePreview } from 'librechat-data-provider';
import { useRetrySGFileMutation } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      retryFileProcessing: jest.fn(),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
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
