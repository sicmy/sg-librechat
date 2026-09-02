import { memo, useMemo } from 'react';
import { FileText } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { sgCitationMetadataSchema } from 'librechat-data-provider';
import type { SGTypedCitation, TMessage } from 'librechat-data-provider';
import CitationLocation from '~/components/SidePanel/Citations/Location';
import { useLocalize } from '~/hooks';
import store from '~/store';

const VISIBLE_CITATIONS = 3;

function CitationBadges({ message }: { message: TMessage }) {
  const localize = useLocalize();
  const setCitationPanel = useSetRecoilState(store.sgCitationPanel);
  const metadata = useMemo(() => {
    const parsed = sgCitationMetadataSchema.safeParse(message.metadata?.sgCitations);
    return parsed.success && parsed.data.citations.length > 0 ? parsed.data : null;
  }, [message.metadata?.sgCitations]);

  if (!metadata) {
    return null;
  }

  const openCitation = (citation: SGTypedCitation) => {
    setCitationPanel({
      messageId: message.messageId,
      metadata,
      selectedCitationId: citation.citation_id,
    });
  };

  const visible = metadata.citations.slice(0, VISIBLE_CITATIONS);
  const remaining = metadata.citations.length - visible.length;

  return (
    <div
      className="flex max-w-full flex-wrap items-center gap-1.5"
      aria-label={localize('com_sg_citation_sources')}
    >
      {visible.map((citation, index) => (
        <button
          key={citation.citation_id}
          type="button"
          onClick={() => openCitation(citation)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-light bg-surface-secondary px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-medium hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          aria-label={localize('com_sg_citation_open_source', {
            index: index + 1,
            name: citation.display_name,
          })}
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-active text-[10px] font-semibold text-text-primary">
            {index + 1}
          </span>
          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-48 truncate font-medium">{citation.display_name}</span>
          <span className="shrink-0 text-text-tertiary">
            <CitationLocation locator={citation.locator} />
          </span>
        </button>
      ))}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => openCitation(metadata.citations[VISIBLE_CITATIONS])}
          className="rounded-full px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        >
          {localize('com_sg_citation_more_sources', { count: remaining })}
        </button>
      )}
    </div>
  );
}

export default memo(CitationBadges);
