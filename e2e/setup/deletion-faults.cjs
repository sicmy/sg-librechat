module.exports = function installDeletionFaults(db) {
  const { startSGFileDeletionWorker, resumeSGConversationDeletion } = require('@librechat/api');
  const { getAppConfig } = require('~/server/services/Config');
  const app = require('../../api/server/index.js');
  const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
  app.get('/__e2e/deletion-status', requireJwtAuth, async (req, res, next) => {
    try {
      const job = await db.findResourceDeletion(
        req.user.id,
        req.query.fileId ? 'file' : 'conversation',
        [req.query.fileId ?? req.query.conversationId],
      );
      res.json(
        job ? [{ resourceIds: job.resourceIds, state: job.state, attempts: job.attempts }] : [],
      );
    } catch (error) {
      next(error);
    }
  });
  const cleanup = db.removeSGFileReferences;
  const failed = new Set();
  db.removeSGFileReferences = async function (userId, conversationId, fileIds, requestIds) {
    const key = JSON.stringify([userId, [...fileIds].sort()]);
    if (!failed.has(key)) {
      failed.add(key);
      throw new Error('synthetic_file_cleanup_failure');
    }
    return cleanup(userId, conversationId, fileIds, requestIds);
  };
  const deleteTools = db.deleteToolCalls;
  const failedConversations = new Set();
  db.deleteToolCalls = async function (userId, conversationId) {
    const key = JSON.stringify([userId, conversationId]);
    if (conversationId && !failedConversations.has(key)) {
      failedConversations.add(key);
      throw new Error('synthetic_conversation_cleanup_failure');
    }
    return deleteTools(userId, conversationId);
  };
  startSGFileDeletionWorker({
    methods: db,
    loadConfig: (tenantId) => getAppConfig({ tenantId }),
    intervalMs: 1000,
    resumeConversation: async (job) => {
      await resumeSGConversationDeletion({
        job,
        methods: db,
        loadConfig: () => getAppConfig({ tenantId: job.tenantId }),
      });
    },
  });
};
