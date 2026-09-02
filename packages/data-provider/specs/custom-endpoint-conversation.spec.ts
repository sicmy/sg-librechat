import { tConversationSchema } from '../src/schemas';

describe('custom endpoint conversation contract', () => {
  it('preserves a configured endpoint name while keeping endpointType typed', () => {
    const conversation = tConversationSchema.parse({
      conversationId: 'conversation-1',
      endpoint: 'SG AI Gateway',
      endpointType: 'custom',
      title: 'Gateway chat',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });

    expect(conversation.endpoint).toBe('SG AI Gateway');
    expect(conversation.endpointType).toBe('custom');
  });
});
