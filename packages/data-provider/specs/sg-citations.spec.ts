import { sgCitationMetadataSchema, tMessageSchema } from '../src/schemas';

const metadata = {
  schema_version: 1,
  citations: [
    {
      schema_version: 1,
      citation_id: 'cite_123',
      file_id: 'file_123',
      display_name: 'policy.pdf',
      mime_type: 'application/pdf',
      locator: {
        kind: 'page',
        page_number: 2,
        bbox: {
          coordinate_space: 'normalized',
          left: 0.1,
          top: 0.2,
          right: 0.8,
          bottom: 0.4,
        },
      },
      quote: 'Approved equipment must be inspected monthly.',
      relevance_score: 0.94,
      preview_path: '/internal/files/file_123/pages/2',
      download_path: '/internal/files/file_123/download',
    },
  ],
} as const;

describe('SG citation contract', () => {
  it('accepts the versioned Gateway envelope in message metadata', () => {
    expect(sgCitationMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      tMessageSchema.parse({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        parentMessageId: 'message-0',
        text: 'Monthly inspection is required.',
        isCreatedByUser: false,
        metadata: { sgCitations: metadata },
      }).metadata?.sgCitations,
    ).toEqual(metadata);
  });

  it('rejects paths that do not match the citation file and locator', () => {
    expect(
      sgCitationMetadataSchema.safeParse({
        ...metadata,
        citations: [
          {
            ...metadata.citations[0],
            preview_path: '/internal/files/file_other/pages/2',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
