import { createElement } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecoilRoot, useRecoilState } from 'recoil';
import store from '~/store';
import { dataService, QueryKeys, FileSources } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TFilePreview } from 'librechat-data-provider';
import {
  useRetrySGFileMutation,
  useCancelSGFileMutation,
  useUploadFileMutation,
  useDeleteFilesMutation,
} from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      retryFileProcessing: jest.fn(),
      cancelFileProcessing: jest.fn(),
      deleteFiles: jest.fn(),
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
  it('clears a source panel that refers only to the deleted file', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    jest
      .mocked(dataService.deleteFiles)
      .mockResolvedValue({ message: 'deleted', result: {}, deleted_file_ids: ['root'] });
    const { result } = renderHook(
      () => {
        const [panel, setPanel] = useRecoilState(store.sgCitationPanel);
        return { panel, setPanel, deletion: useDeleteFilesMutation() };
      },
      { wrapper: createWrapper(queryClient) },
    );
    act(() =>
      result.current.setPanel({
        messageId: 'message',
        selectedCitationId: 'citation',
        metadata: {
          schema_version: 1,
          citations: [
            {
              schema_version: 1,
              citation_id: 'citation',
              file_id: 'root',
              display_name: 'test.png',
              mime_type: 'image/png',
              locator: { kind: 'image', image_id: 'root' },
              quote: 'private quotation',
              relevance_score: 1,
              preview_path: '/internal/files/root/image',
              download_path: '/internal/files/root/download',
            },
          ],
        },
      }),
    );
    await act(async () => {
      await result.current.deletion.mutateAsync({
        files: [
          { file_id: 'root', filepath: '/file', embedded: false, source: FileSources.sg_gateway },
        ],
      });
    });
    expect(result.current.panel).toBeNull();
  });
  it('removes all reported descendants from caches and refreshes messages', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      [QueryKeys.files],
      [{ file_id: 'root' }, { file_id: 'child' }, { file_id: 'keep' }],
    );
    queryClient.setQueryData([QueryKeys.sgCitationDownload, 'child'], new Blob(['child']));
    queryClient.setQueryData([QueryKeys.sgCitationDownload, 'keep'], new Blob(['keep']));
    const invalidated = jest.spyOn(queryClient, 'invalidateQueries');
    jest
      .mocked(dataService.deleteFiles)
      .mockResolvedValue({ message: 'deleted', result: {}, deleted_file_ids: ['root', 'child'] });
    const { result } = renderHook(() => useDeleteFilesMutation(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        files: [
          { file_id: 'root', filepath: '/file', embedded: false, source: FileSources.sg_gateway },
        ],
      });
    });
    expect(queryClient.getQueryData([QueryKeys.files])).toEqual([{ file_id: 'keep' }]);
    expect(queryClient.getQueryData([QueryKeys.sgCitationDownload, 'child'])).toBeUndefined();
    expect(queryClient.getQueryData([QueryKeys.sgCitationDownload, 'keep'])).toBeDefined();
    expect(invalidated).toHaveBeenCalledWith([QueryKeys.messages]);
  });
  it('keeps a late pending poll from overwriting successful cancellation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fileId = 'file_cancel_test';
    const queryKey = [QueryKeys.filePreview, fileId];
    let finishPoll: (value: TFilePreview) => void = () => {};
    const polling = queryClient
      .fetchQuery(
        queryKey,
        () =>
          new Promise<TFilePreview>((resolve) => {
            finishPoll = resolve;
          }),
      )
      .catch(() => undefined);
    const cancelled: TFilePreview = {
      file_id: fileId,
      status: 'failed',
      previewError: 'job_cancelled',
    };
    jest.mocked(dataService.cancelFileProcessing).mockResolvedValue(cancelled);
    const { result } = renderHook(() => useCancelSGFileMutation(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync(fileId);
      finishPoll({ file_id: fileId, status: 'pending' });
      await polling;
    });
    expect(queryClient.getQueryData(queryKey)).toEqual(cancelled);
  });
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
