import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import CitationPanel from '../Panel';
import store from '~/store';

const mockDownload = jest.fn();
const mockUseSGCitationPage = jest.fn();

jest.mock('~/data-provider/Files/queries', () => ({
  useSGCitationDownload: () => ({ refetch: mockDownload, isFetching: false }),
  useSGCitationPage: (...args: unknown[]) => mockUseSGCitationPage(...args),
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

describe('SG citation panel', () => {
  beforeEach(() => {
    mockDownload.mockReset();
    mockUseSGCitationPage.mockReturnValue({ data: undefined, isLoading: true, isError: false });
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
