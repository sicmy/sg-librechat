import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import CitationPanel from '../Panel';
import store from '~/store';

const mockDownload = jest.fn();
const mockUseSGCitationPage = jest.fn();
const mockUseSGCitationImage = jest.fn();
const mockUseSGCitationFrame = jest.fn();

jest.mock('~/data-provider/Files/queries', () => ({
  useSGCitationDownload: () => ({ refetch: mockDownload, isFetching: false }),
  useSGCitationPage: (...args: unknown[]) => mockUseSGCitationPage(...args),
  useSGCitationImage: (...args: unknown[]) => mockUseSGCitationImage(...args),
  useSGCitationFrame: (...args: unknown[]) => mockUseSGCitationFrame(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) => {
    if (key === 'com_sg_citation_page') {
      return `Page ${values?.page}`;
    }
    if (key === 'com_sg_citation_source_count') {
      return `${values?.count} cited locations`;
    }
    if (key === 'com_ui_relevance') {
      return 'Relevance';
    }
    return key;
  },
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

const metadata = {
  schema_version: 1 as const,
  citations: [
    {
      schema_version: 1 as const,
      citation_id: 'cite_123',
      file_id: 'file_123',
      display_name: 'policy.pdf',
      mime_type: 'application/pdf',
      locator: { kind: 'page' as const, page_number: 2 },
      quote: 'Monthly inspection is required.',
      relevance_score: 0.94,
      preview_path: '/internal/files/file_123/pages/2',
      download_path: '/internal/files/file_123/download',
    },
  ],
};

const imageMetadata = {
  schema_version: 1 as const,
  citations: [
    {
      schema_version: 1 as const,
      citation_id: 'cite_image',
      file_id: 'file_image',
      display_name: 'safety-panel.png',
      mime_type: 'image/png',
      locator: {
        kind: 'image' as const,
        image_id: 'file_image',
        bbox: {
          coordinate_space: 'normalized' as const,
          left: 0.18,
          top: 0.05,
          right: 0.41,
          bottom: 0.57,
        },
      },
      quote: 'The pressure needle is in the red danger zone.',
      relevance_score: 0.98,
      preview_path: '/internal/files/file_image/image',
      download_path: '/internal/files/file_image/download',
    },
  ],
};

describe('SG citation panel', () => {
  beforeEach(() => {
    mockDownload.mockReset();
    mockUseSGCitationPage.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    mockUseSGCitationImage.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    mockUseSGCitationFrame.mockReturnValue({ data: undefined, isLoading: true, isError: false });
  });

  it('loads only the selected PDF page and exposes the exact quote', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'message-1',
            metadata,
            selectedCitationId: 'cite_123',
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );

    expect(mockUseSGCitationPage).toHaveBeenCalledWith('file_123', 2);
    expect(screen.getAllByText('Monthly inspection is required.')).toHaveLength(2);
    expect(screen.getByText('Relevance: 94%')).toBeInTheDocument();
  });

  it('closes without changing message or artifact state', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'message-1',
            metadata,
            selectedCitationId: 'cite_123',
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('shows readable JSON paths in both the selected source and source list', () => {
    const locator = Object.freeze({
      kind: 'structural_path' as const,
      path_type: 'json' as const,
      path: '$["items"][1]["quantity"]',
    });
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'json-message',
            selectedCitationId: 'cite_123',
            metadata: {
              schema_version: 1,
              citations: [
                {
                  ...metadata.citations[0],
                  display_name: '12-data.json',
                  mime_type: 'application/json',
                  locator,
                  preview_path: null,
                },
              ],
            },
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );
    expect(screen.getAllByText('$.items[1].quantity', { exact: false })).toHaveLength(2);
    expect(screen.queryByText(locator.path, { exact: false })).not.toBeInTheDocument();
    expect(locator.path).toBe('$["items"][1]["quantity"]');
  });

  it('loads video frame zero without treating it as a missing frame', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'video-message',
            selectedCitationId: 'cite_video',
            metadata: {
              schema_version: 1,
              citations: [
                {
                  ...metadata.citations[0],
                  citation_id: 'cite_video',
                  mime_type: 'video/mp4',
                  locator: { kind: 'timestamp', start_ms: 0, end_ms: 0, frame_number: 0 },
                  preview_path: '/internal/files/file_123/frames/0',
                },
              ],
            },
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );
    expect(mockUseSGCitationFrame).toHaveBeenCalledWith('file_123', 0);
  });

  it('loads an authorized image preview and overlays its normalized bbox', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = jest.fn(() => 'blob:citation');
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    mockUseSGCitationImage.mockReturnValue({
      data: new Blob(['image']),
      isLoading: false,
      isError: false,
    });
    const { unmount } = render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'message-image',
            metadata: imageMetadata,
            selectedCitationId: 'cite_image',
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );

    expect(mockUseSGCitationImage).toHaveBeenCalledWith('file_image');
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:citation');
    expect(screen.getByTestId('sg-citation-highlight')).toHaveStyle({
      left: '18%',
      top: '5%',
      width: '23%',
      height: '52%',
    });

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:citation');
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      });
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('shows a localized error when the scoped original cannot be downloaded', async () => {
    mockDownload.mockResolvedValue({ data: undefined });
    render(
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.sgCitationPanel, {
            messageId: 'message-1',
            metadata,
            selectedCitationId: 'cite_123',
          })
        }
      >
        <CitationPanel />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('com_sg_citation_download_error');
  });
});
