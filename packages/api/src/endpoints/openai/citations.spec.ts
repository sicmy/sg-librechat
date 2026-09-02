import { createServer } from 'node:http';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { AddressInfo } from 'node:net';

const citations = {
  schema_version: 1,
  citations: [
    {
      schema_version: 1,
      citation_id: 'cite_contract',
      file_id: 'file_contract',
      display_name: 'policy.pdf',
      mime_type: 'application/pdf',
      locator: { kind: 'page', page_number: 2 },
      quote: 'Monthly inspection is required.',
      relevance_score: 0.94,
      preview_path: '/internal/files/file_contract/pages/2',
      download_path: '/internal/files/file_contract/download',
    },
  ],
};

describe('SG Gateway raw citation response', () => {
  it('survives ChatOpenAI streaming conversion for the model-end handler', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-contract',
          object: 'chat.completion.chunk',
          model: 'default',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'answer' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-contract',
          object: 'chat.completion.chunk',
          model: 'default',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          sg_citations: citations,
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const model = new ChatOpenAI({
        apiKey: 'contract-key',
        model: 'default',
        streaming: true,
        __includeRawResponse: true,
        configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` },
      });

      const message = await model.invoke([new HumanMessage('hello')]);

      expect(message.additional_kwargs.__raw_response).toMatchObject({
        sg_citations: citations,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
