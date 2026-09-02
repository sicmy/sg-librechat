import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import CitationBadges from '../Badges';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) => {
    if (key === 'com_sg_citation_page') {
      return `Page ${values?.page}`;
    }
    if (key === 'com_sg_citation_open_source') {
      return `Open source ${values?.index}: ${values?.name}`;
    }
    return key;
  },
}));

const citation = {
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
};

function PanelState() {
  const panel = useRecoilValue(store.sgCitationPanel);
  return <output>{panel?.selectedCitationId ?? 'closed'}</output>;
}

describe('SG citation badges', () => {
  it('opens the selected typed citation in the shared side panel', () => {
    const message: TMessage = {
      messageId: 'message-1',
      conversationId: 'conversation-1',
      parentMessageId: 'message-0',
      text: 'Monthly inspection is required.',
      isCreatedByUser: false,
      metadata: {
        sgCitations: { schema_version: 1, citations: [citation] },
      },
    };

    render(
      <RecoilRoot>
        <CitationBadges message={message} />
        <PanelState />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open source 1: policy.pdf' }));

    expect(screen.getByText('cite_123')).toBeInTheDocument();
  });

  it('does not render malformed untrusted metadata', () => {
    const message: TMessage = {
      messageId: 'message-1',
      conversationId: 'conversation-1',
      parentMessageId: 'message-0',
      text: 'No valid citation.',
      isCreatedByUser: false,
      metadata: {
        sgCitations: { schema_version: 1, citations: [{ ...citation, download_path: '/wrong' }] },
      },
    };

    const { container } = render(
      <RecoilRoot>
        <CitationBadges message={message} />
      </RecoilRoot>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
