import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import FilePreviewDialog from '../FilePreviewDialog';

const mockDownload = jest.fn();
const mockShared = jest.fn();
const mockDocument = jest.fn();
const mockTrigger = jest.fn();
let mockShareId: string | undefined;
jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: mockDownload }),
  useSharedFileDownload: () => ({ refetch: mockShared }),
  useSGDocumentPreview: () => ({ refetch: mockDocument }),
}));
jest.mock('~/Providers', () => ({ useShareContext: () => ({ shareId: mockShareId }) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  logger: { error: jest.fn() },
  sortPagesByRelevance: (pages: number[]) => pages,
  triggerDownload: (...args: string[]) => mockTrigger(...args),
}));
jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => null,
}));

const dialog = (open = true, name = '02-scanned.pdf', filePath?: string, fileType?: string) => (
  <RecoilRoot>
    <FilePreviewDialog
      open={open}
      onOpenChange={() => undefined}
      fileName={name}
      fileId={name}
      filePath={filePath}
      fileType={fileType}
    />
  </RecoilRoot>
);

describe('attachment preview dialog', () => {
  it('renders an SG DOCX as PDF while downloading the original separately', async () => {
    mockDocument.mockResolvedValue({ data: new Blob(['%PDF-1.7']), isError: false });
    render(
      <RecoilRoot>
        <FilePreviewDialog
          open
          onOpenChange={() => undefined}
          fileName="04-document.docx"
          fileId="docx-id"
          fileSource="sg_gateway"
        />
      </RecoilRoot>,
    );
    expect(await screen.findByTitle('com_ui_preview: 04-document.docx')).toHaveAttribute(
      'src',
      'blob:preview',
    );
    expect(mockDocument).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download 04-document.docx' }));
    await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:owned', '04-document.docx'));
  });

  it('shows an error when document rendering fails without displaying original ZIP bytes', async () => {
    mockDocument.mockResolvedValue({ isError: true });
    render(
      <RecoilRoot>
        <FilePreviewDialog
          open
          onOpenChange={() => undefined}
          fileName="04-document.docx"
          fileId="docx-id"
          fileSource="sg_gateway"
        />
      </RecoilRoot>,
    );
    expect(await screen.findByText('com_ui_preview_load_error')).toBeInTheDocument();
    expect(mockDownload).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/xml', 'application/octet-stream'])(
    'rejects misleading DOCX MIME %s',
    (mime) => {
      render(dialog(true, '04-document.docx', undefined, mime));
      expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
      expect(mockDownload).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['04-document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    [
      '06-presentation.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    ['07-workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('does not mistake zipped Office MIME for XML text: %s', (name, mime) => {
    render(dialog(true, name, undefined, mime));
    expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  const originalFetch = global.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareId = undefined;
    mockDownload.mockResolvedValue({ data: 'blob:owned', isError: false });
    mockShared.mockResolvedValue({ data: 'blob:shared', isError: false });
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        blob: async () => ({ text: async () => '<script>plain text</script>' }),
      }),
    });
    URL.createObjectURL = jest.fn().mockReturnValue('blob:preview');
    URL.revokeObjectURL = jest.fn();
  });
  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('loads a PDF, downloads it and cleans up on close/reopen', async () => {
    const { rerender } = render(dialog());
    expect(await screen.findByTitle('com_ui_preview: 02-scanned.pdf')).toHaveAttribute(
      'src',
      'blob:preview',
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download 02-scanned.pdf' }));
    await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:owned', '02-scanned.pdf'));
    rerender(dialog(false));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    rerender(dialog());
    expect(await screen.findByTitle('com_ui_preview: 02-scanned.pdf')).toBeInTheDocument();
  });

  it('uses only the shared route for snapshots', async () => {
    mockShareId = 'share';
    render(dialog(true, '02-scanned.pdf', '/api/share/share/files/file'));
    await screen.findByTitle('com_ui_preview: 02-scanned.pdf');
    expect(mockShared).toHaveBeenCalledTimes(1);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('ignores a late response after switching files', async () => {
    let finish: (result: { data: string; isError: boolean }) => void = () => undefined;
    mockDownload.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { rerender } = render(dialog());
    rerender(dialog(true, '08-text.txt'));
    expect(await screen.findByText('<script>plain text</script>')).toBeInTheDocument();
    await act(async () => {
      finish({ data: 'blob:old', isError: false });
    });
    expect(global.fetch).not.toHaveBeenCalledWith('blob:old');
    expect(screen.queryByTitle('com_ui_preview: 02-scanned.pdf')).not.toBeInTheDocument();
  });

  it('does not render stale cached data when a refetch fails', async () => {
    mockDownload.mockResolvedValue({ data: 'blob:stale', isError: true });
    render(dialog());
    expect(await screen.findByText('com_ui_preview_load_error')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('distinguishes failed downloads from unsupported previews without retry loops', async () => {
    mockDownload.mockResolvedValue({ isError: true });
    render(dialog());
    expect(await screen.findByText('com_ui_preview_load_error')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_preview_unavailable')).not.toBeInTheDocument();
    expect(mockDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download 02-scanned.pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_download_error');
  });

  it.each(['04-document.docx', '05-document.odt', '06-presentation.pptx', '07-workbook.xlsx'])(
    'allows download without claiming visual preview support for %s',
    async (name) => {
      render(dialog(true, name));
      expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
      expect(mockDownload).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: `com_ui_download ${name}` }));
      await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:owned', name));
    },
  );

  it.each([
    '08-text.txt',
    '09-markdown.md',
    '10-code.py',
    '11-table.csv',
    '12-data.json',
    '13-data.xml',
  ])('renders %s as inert text', async (name) => {
    render(dialog(true, name));
    expect(await screen.findByText('<script>plain text</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
