import { useCallback, useEffect, useState } from 'react';
import { useRecoilState } from 'recoil';
import { Button } from '@librechat/client';
import { Download, FileText, LocateFixed, X } from 'lucide-react';
import type { SGTypedCitation } from 'librechat-data-provider';
import { useSGCitationDownload, useSGCitationPage } from '~/data-provider/Files/queries';
import { triggerDownload } from '~/utils';
import CitationLocation from './Location';
import { useLocalize } from '~/hooks';
import store from '~/store';

function PagePreview({ citation }: { citation: SGTypedCitation }) {
  const localize = useLocalize();
  const pageNumber = citation.locator.kind === 'page' ? citation.locator.page_number : undefined;
  const { data, isLoading, isError } = useSGCitationPage(citation.file_id, pageNumber);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(data);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-xl border border-border-light bg-surface-secondary">
        <span className="shimmer text-sm text-text-secondary">{localize('com_ui_loading')}</span>
      </div>
    );
  }

  if (isError || !url) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-xl border border-border-light bg-surface-secondary px-6 text-center text-sm text-text-secondary">
        {localize('com_sg_citation_preview_error')}
      </div>
    );
  }

  const box = citation.locator.kind === 'page' ? citation.locator.bbox : null;

  return (
    <div className="overflow-auto rounded-xl border border-border-light bg-surface-secondary p-3">
      <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-lg shadow-sm">
        <img
          src={url}
          alt={localize('com_sg_citation_page_preview', {
            name: citation.display_name,
            page: pageNumber,
          })}
          className="block max-h-[52vh] max-w-full object-contain"
        />
        {box && (
          <span
            className="pointer-events-none absolute border-2 border-text-primary bg-surface-active/20 shadow-sm"
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${(box.right - box.left) * 100}%`,
              height: `${(box.bottom - box.top) * 100}%`,
            }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

export default function CitationPanel() {
  const localize = useLocalize();
  const [panel, setPanel] = useRecoilState(store.sgCitationPanel);
  const [downloadError, setDownloadError] = useState(false);
  const citations = panel?.metadata.citations ?? [];
  const selected =
    citations.find((citation) => citation.citation_id === panel?.selectedCitationId) ??
    citations[0];
  const { refetch: download, isFetching: isDownloading } = useSGCitationDownload(selected?.file_id);

  const close = useCallback(() => setPanel(null), [setPanel]);
  const selectCitation = useCallback(
    (citationId: string) => {
      setDownloadError(false);
      setPanel((current) => (current ? { ...current, selectedCitationId: citationId } : current));
    },
    [setPanel],
  );
  const handleDownload = useCallback(async () => {
    if (!selected) {
      return;
    }
    setDownloadError(false);
    try {
      const result = await download();
      if (!result.data) {
        setDownloadError(true);
        return;
      }
      triggerDownload(URL.createObjectURL(result.data), selected.display_name);
    } catch {
      setDownloadError(true);
      return;
    }
  }, [download, selected]);

  if (!panel || !selected) {
    return null;
  }

  const canPreview = selected.mime_type === 'application/pdf' && selected.locator.kind === 'page';

  return (
    <aside
      className="flex h-full min-w-0 flex-col bg-surface-primary"
      aria-label={localize('com_sg_citation_sources')}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border-light px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-secondary">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-primary">
              {localize('com_sg_citation_sources')}
            </h2>
            <p className="text-xs text-text-secondary">
              {localize('com_sg_citation_source_count', { count: citations.length })}
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={close}
          className="size-8"
          aria-label={localize('com_ui_close')}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border-light p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text-primary">
                {selected.display_name}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                <LocateFixed className="size-3.5" aria-hidden="true" />
                <span>
                  <CitationLocation locator={selected.locator} />
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {localize('com_ui_relevance')}: {Math.round(selected.relevance_score * 100)}%
                </span>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDownload}
              disabled={isDownloading}
              className="shrink-0 gap-1.5"
            >
              <Download className="size-3.5" aria-hidden="true" />
              {localize('com_ui_download')}
            </Button>
          </div>

          {canPreview ? (
            <PagePreview citation={selected} />
          ) : (
            <div className="rounded-xl border border-border-light bg-surface-secondary p-4 text-sm text-text-secondary">
              {localize('com_sg_citation_no_visual_preview')}
            </div>
          )}

          <blockquote className="mt-3 border-l-2 border-border-heavy pl-3 text-sm leading-6 text-text-primary">
            {selected.quote}
          </blockquote>
          {downloadError && (
            <p role="alert" className="mt-3 text-xs text-text-secondary">
              {localize('com_sg_citation_download_error')}
            </p>
          )}
        </div>

        <nav className="space-y-1 p-2" aria-label={localize('com_sg_citation_all_sources')}>
          {citations.map((citation, index) => {
            const active = citation.citation_id === selected.citation_id;
            return (
              <button
                key={citation.citation_id}
                type="button"
                onClick={() => selectCitation(citation.citation_id)}
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy ${
                  active ? 'bg-surface-active' : 'hover:bg-surface-hover'
                }`}
                aria-current={active ? 'true' : undefined}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border-medium text-[11px] font-semibold text-text-secondary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {citation.display_name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-text-secondary">
                    <CitationLocation locator={citation.locator} /> ·{' '}
                    {Math.round(citation.relevance_score * 100)}%
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-tertiary">
                    {citation.quote}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
