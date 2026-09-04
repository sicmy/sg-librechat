jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  emitEvent: jest.fn(),
  createToolExecuteHandler: jest.fn(),
  markSummarizationUsage: (usage) => usage,
}));
jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));
jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

const { ModelEndHandler, getDefaultHandlers } = require('../callbacks');

const buildGraph = () => ({
  getAgentContext: () => ({
    provider: 'vertexai',
    clientOptions: { model: 'gemini-3.1-flash-lite-preview' },
  }),
});

const citations = {
  schema_version: 1,
  citations: [
    {
      schema_version: 1,
      citation_id: 'cite_123',
      file_id: 'file_123',
      display_name: 'policy.pdf',
      mime_type: 'application/pdf',
      locator: { kind: 'page', page_number: 2 },
      quote: 'Monthly inspection is required.',
      relevance_score: 0.94,
      preview_path: '/internal/files/file_123/pages/2',
      download_path: '/internal/files/file_123/download',
    },
  ],
};

describe('ModelEndHandler — Vertex thoughtSignature capture (issue #13006 follow-up)', () => {
  it('maps non-empty signatures onto tool_call_ids in order', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          tool_calls: [
            { id: 'tc_a', name: 'a', args: {} },
            { id: 'tc_b', name: 'b', args: {} },
          ],
          additional_kwargs: { signatures: ['SIG_A', '', 'SIG_B'] },
        },
      },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({ tc_a: 'SIG_A', tc_b: 'SIG_B' });
    expect(collectedUsage).toHaveLength(1);
  });

  it('accumulates per-id across multiple model_end events (multi-step tool turn)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG_step1'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );
    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step2', name: 'b', args: {} }],
          additional_kwargs: { signatures: ['SIG_step2'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({
      tc_step1: 'SIG_step1',
      tc_step2: 'SIG_step2',
    });
  });

  it('is a no-op for signatures when collectedThoughtSignatures is null', async () => {
    const collectedUsage = [];
    const handler = new ModelEndHandler(collectedUsage, null);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedUsage).toHaveLength(1);
  });

  it('does not store anything when signatures field is missing (non-Vertex providers)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: {},
        },
      },
      { ls_model_name: 'gpt-4', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('does not store anything when tool_calls is missing', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          additional_kwargs: { signatures: ['SIG_orphan'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('tags the producing agent on collected + emitted usage for per-endpoint pricing', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);
    const graph = {
      getAgentContext: () => ({
        provider: 'openai',
        agentId: 'agent_sub',
        clientOptions: { model: 'gpt-4' },
      }),
    };

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gpt-4', run_id: 'r1', user_id: 'u1' },
      graph,
    );

    expect(collectedUsage[0].agentId).toBe('agent_sub');
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent_sub' }));
  });

  it('leaves usage untagged when the graph context has no agentId (single-endpoint)', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', run_id: 'r1', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedUsage[0].agentId).toBeUndefined();
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: undefined }));
  });

  it('captures validated SG citations from the raw Gateway response', async () => {
    const sink = { latest: null };
    const handler = new ModelEndHandler([], null, null, sink);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          additional_kwargs: { __raw_response: { sg_citations: citations } },
        },
      },
      { user_id: 'u1' },
      buildGraph(),
    );

    expect(sink.latest).toEqual(citations);
  });

  it('captures SG citations from a terminal stream chunk before model-end aggregation', async () => {
    const { GraphEvents } = jest.requireActual('@librechat/agents');
    const sink = { latest: null };
    const handlers = getDefaultHandlers({
      res: { write: jest.fn() },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      sgCitationSink: sink,
    });

    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(GraphEvents.CHAT_MODEL_STREAM, {
      chunk: { additional_kwargs: { __raw_response: { sg_citations: citations } } },
    });

    expect(sink.latest).toEqual(citations);
  });

  it('throws when collectedUsage is not an array (existing contract)', () => {
    expect(() => new ModelEndHandler(null)).toThrow('collectedUsage must be an array');
  });
});
