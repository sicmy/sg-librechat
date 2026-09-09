const express = require('express');
const request = require('supertest');

const MOCKS = '../__test-utils__/convos-route-mocks';

jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () => require(MOCKS).api());
jest.mock('@librechat/data-schemas', () => require(MOCKS).dataSchemas());
jest.mock('librechat-data-provider', () => require(MOCKS).dataProvider());
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware', () => require(MOCKS).middlewarePassthrough());
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => require(MOCKS).importUtils());
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => require(MOCKS).multerSetup());
jest.mock('multer', () => require(MOCKS).multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());

describe('Convos Routes', () => {
  let app;
  let convosRouter;
  const {
    deleteToolCalls,
    deleteConvos,
    getFiles,
    getMessages,
    getConversationsForDeletion,
    saveConvo,
  } = require('~/models');
  const {
    deleteSGConversationResources,
    deleteAllSharedLinksWithCleanup,
    deleteConvoSharedLinksWithCleanup,
  } = require('@librechat/api');

  beforeAll(() => {
    convosRouter = require('../convos');

    app = express();
    app.use(express.json());

    /** Mock authenticated user */
    app.use((req, res, next) => {
      req.user = { id: 'test-user-123' };
      next();
    });

    app.use('/api/convos', convosRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getMessages.mockResolvedValue([]);
    getFiles.mockResolvedValue([]);
    getConversationsForDeletion.mockImplementation((_user, id) =>
      Promise.resolve(id ? [id] : ['selected-conversation']),
    );
    deleteSGConversationResources.mockResolvedValue();
  });

  describe('journaled deletion routes', () => {
    const { deleteSGConversations, SGFileGatewayError } = require('@librechat/api');
    beforeEach(() => deleteSGConversations.mockReset());
    it('passes an owned selection snapshot and the authenticated actor to bulk cleanup', async () => {
      getConversationsForDeletion.mockResolvedValueOnce(['a', 'archived']);
      const result = { acknowledged: true, deletedCount: 2, conversationIds: ['a', 'archived'] };
      deleteSGConversations.mockResolvedValue(result);
      const response = await request(app).delete('/api/convos/all');
      expect(response.status).toBe(201);
      expect(response.body).toEqual(result);
      expect(deleteSGConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-123',
          conversationIds: ['a', 'archived'],
          methods: require('~/models'),
        }),
      );
      expect(deleteConvos).not.toHaveBeenCalled();
      expect(deleteToolCalls).not.toHaveBeenCalled();
      expect(deleteAllSharedLinksWithCleanup).not.toHaveBeenCalled();
    });
    it('delegates single deletion and durable retry to the owner-scoped service', async () => {
      deleteSGConversations.mockResolvedValue({ deletedCount: 0, conversationIds: ['removed'] });
      const response = await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'removed', userId: 'forged' } });
      expect(response.status).toBe(201);
      expect(deleteSGConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-123',
          conversationIds: ['removed'],
        }),
      );
      expect(deleteConvoSharedLinksWithCleanup).not.toHaveBeenCalled();
    });
    it('preserves a not-found refusal from the authoritative deletion service', async () => {
      deleteSGConversations.mockRejectedValue(
        new SGFileGatewayError(404, 'conversation_not_found'),
      );
      expect(
        (
          await request(app)
            .delete('/api/convos')
            .send({ arg: { conversationId: 'foreign' } })
        ).status,
      ).toBe(404);
      expect(deleteConvos).not.toHaveBeenCalled();
    });
    it.each(['/api/convos', '/api/convos/all'])(
      'reports cleanup failure from %s without claiming success',
      async (url) => {
        deleteSGConversations.mockRejectedValue(new Error('synthetic_failure'));
        const response = await request(app)
          .delete(url)
          .send({ arg: { conversationId: 'selected' } });
        expect(response.status).toBe(500);
        expect(response.text).toBe('Error clearing conversations');
      },
    );
    it('passes an empty bulk snapshot without unrestricted sibling deletion', async () => {
      getConversationsForDeletion.mockResolvedValueOnce([]);
      deleteSGConversations.mockResolvedValue({
        acknowledged: true,
        deletedCount: 0,
        conversationIds: [],
      });
      expect((await request(app).delete('/api/convos/all')).status).toBe(201);
      expect(deleteSGConversations).toHaveBeenCalledWith(
        expect.objectContaining({ conversationIds: [] }),
      );
      expect(deleteAllSharedLinksWithCleanup).not.toHaveBeenCalled();
      expect(deleteToolCalls).not.toHaveBeenCalled();
    });
    it.each([
      {},
      { arg: null },
      { arg: {} },
      { arg: { endpoint: 'SG AI Gateway' } },
      { arg: { conversationId: ['a'] } },
    ])('rejects invalid deletion parameters %j', async (body) => {
      expect((await request(app).delete('/api/convos').send(body)).status).toBe(400);
      expect(deleteSGConversations).not.toHaveBeenCalled();
    });
    it('keeps the empty new-conversation button no-op', async () => {
      expect(
        (
          await request(app)
            .delete('/api/convos')
            .send({ arg: { source: 'button' } })
        ).status,
      ).toBe(200);
      expect(deleteSGConversations).not.toHaveBeenCalled();
    });
  });
  describe('GET / search handling', () => {
    const { getConvosByCursor } = require('~/models');

    beforeEach(() => {
      getConvosByCursor.mockResolvedValue({ conversations: [], nextCursor: null });
    });

    /** Express already percent-decodes `req.query`, so decoding a second time in the route
     * threw URIError on any term containing a bare `%` and mangled `%xx`-looking text. */
    it('accepts a search term containing a literal percent sign', async () => {
      const response = await request(app)
        .get('/api/convos')
        .query({ isArchived: 'true', search: '100% ready' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: '100% ready' }),
      );
    });

    it('passes percent-escape-looking text through without decoding it', async () => {
      const response = await request(app).get('/api/convos').query({ search: 'a%41b' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: 'a%41b' }),
      );
    });

    it('treats a whitespace-only search as no search', async () => {
      const response = await request(app).get('/api/convos').query({ search: '   ' });

      expect(response.status).toBe(200);
      expect(getConvosByCursor).toHaveBeenCalledWith(
        'test-user-123',
        expect.objectContaining({ search: undefined }),
      );
    });
  });

  describe('POST /archive', () => {
    it('should archive a conversation successfully', async () => {
      const mockConversationId = 'conv-123';
      const mockArchivedConvo = {
        conversationId: mockConversationId,
        title: 'Test Conversation',
        isArchived: true,
        user: 'test-user-123',
      };

      saveConvo.mockResolvedValue(mockArchivedConvo);

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: true,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockArchivedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-123' }),
        { conversationId: mockConversationId, isArchived: true },
        { context: `POST /api/convos/archive ${mockConversationId}` },
      );
    });

    it('should unarchive a conversation successfully', async () => {
      const mockConversationId = 'conv-456';
      const mockUnarchivedConvo = {
        conversationId: mockConversationId,
        title: 'Unarchived Conversation',
        isArchived: false,
        user: 'test-user-123',
      };

      saveConvo.mockResolvedValue(mockUnarchivedConvo);

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: false,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockUnarchivedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-123' }),
        { conversationId: mockConversationId, isArchived: false },
        { context: `POST /api/convos/archive ${mockConversationId}` },
      );
    });

    it('should return 400 when conversationId is missing', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            isArchived: true,
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when isArchived is not a boolean', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: 'conv-123',
            isArchived: 'true',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'isArchived must be a boolean' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when isArchived is undefined', async () => {
      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: 'conv-123',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'isArchived must be a boolean' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 500 when saveConvo fails', async () => {
      const mockConversationId = 'conv-error';
      saveConvo.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/convos/archive')
        .send({
          arg: {
            conversationId: mockConversationId,
            isArchived: true,
          },
        });

      expect(response.status).toBe(500);
      expect(response.text).toBe('Error archiving conversation');

      const { logger } = require('@librechat/data-schemas');
      expect(logger.error).toHaveBeenCalledWith('Error archiving conversation', expect.any(Error));
    });

    it('should handle empty arg object', async () => {
      const response = await request(app).post('/api/convos/archive').send({
        arg: {},
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
    });
  });

  describe('POST /convos/pin', () => {
    const mockConversationId = 'conv-123';

    it('should pin a conversation', async () => {
      const mockPinnedConvo = { conversationId: mockConversationId, pinned: true };
      saveConvo.mockResolvedValue(mockPinnedConvo);

      const response = await request(app).post('/api/convos/pin').send({ arg: mockPinnedConvo });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockPinnedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        { userId: 'test-user-123' },
        { conversationId: mockConversationId, pinned: true },
        { context: `POST /api/convos/pin ${mockConversationId}` },
      );
    });

    it('should unpin a conversation', async () => {
      const mockUnpinnedConvo = { conversationId: mockConversationId, pinned: false };
      saveConvo.mockResolvedValue(mockUnpinnedConvo);

      const response = await request(app).post('/api/convos/pin').send({ arg: mockUnpinnedConvo });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockUnpinnedConvo);
      expect(saveConvo).toHaveBeenCalledWith(
        { userId: 'test-user-123' },
        { conversationId: mockConversationId, pinned: false },
        { context: `POST /api/convos/pin ${mockConversationId}` },
      );
    });

    it('should return 400 when conversationId is missing', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { pinned: true } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'conversationId is required' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when pinned is not a boolean', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId, pinned: 'yes' } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'pinned must be a boolean' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when pinned is missing', async () => {
      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'pinned is required' });
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('should return 500 when saveConvo fails', async () => {
      saveConvo.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: mockConversationId, pinned: true } });

      expect(response.status).toBe(500);
    });
  });
});

/**
 * Custom Jest matcher to verify function call order
 */
expect.extend({
  toHaveBeenCalledAfter(received, other) {
    const receivedCalls = received.mock.invocationCallOrder;
    const otherCalls = other.mock.invocationCallOrder;

    if (receivedCalls.length === 0) {
      return {
        pass: false,
        message: () =>
          `Expected ${received.getMockName()} to have been called after ${other.getMockName()}, but ${received.getMockName()} was never called`,
      };
    }

    if (otherCalls.length === 0) {
      return {
        pass: false,
        message: () =>
          `Expected ${received.getMockName()} to have been called after ${other.getMockName()}, but ${other.getMockName()} was never called`,
      };
    }

    const lastReceivedCall = receivedCalls[receivedCalls.length - 1];
    const firstOtherCall = otherCalls[0];

    const pass = lastReceivedCall > firstOtherCall;

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received.getMockName()} not to have been called after ${other.getMockName()}`
          : `Expected ${received.getMockName()} to have been called after ${other.getMockName()}`,
    };
  },
});
