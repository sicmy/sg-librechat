module.exports = function installExpiryFixture(db) {
  const { runAsSystem } = require('@librechat/data-schemas');
  const { sweepExpiredFiles } = require('~/server/services/Files/process');
  const app = require('../../api/server/index.js');
  const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
  app.post('/__e2e/expire-messages/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const { Message } = require('mongoose').models;
      const { sweepSGExpiredMessages } = require('@librechat/api');
      const { getAppConfig } = require('~/server/services/Config');
      if (!(await db.getConvoRetention(req.user.id, req.params.conversationId)))
        return res.status(404).end();
      const scope = { user: req.user.id, conversationId: req.params.conversationId };
      await Message.updateMany(scope, { $set: { expiredAt: new Date(0) } });
      const result = await sweepSGExpiredMessages({
        methods: db,
        loadConfig: (tenantId) => getAppConfig({ tenantId }),
      });
      const rows = await Message.find(scope)
        .select('files text metadata expiryReferencesOnly')
        .lean();
      res.json({
        ...result,
        retained: rows.length,
        withContent: rows.filter((row) => row.text != null || row.metadata != null).length,
        references: rows.reduce((sum, row) => sum + (row.files?.length ?? 0), 0),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/__e2e/expire-conversation/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const { Conversation } = require('mongoose').models;
      const { sweepSGExpiredConversations } = require('@librechat/api');
      const { getAppConfig } = require('~/server/services/Config');
      const scope = { user: req.user.id, conversationId: req.params.conversationId };
      const marked = await Conversation.updateOne(scope, { $set: { expiredAt: new Date(0) } });
      if (!marked.matchedCount) return res.status(404).end();
      const before = await Conversation.countDocuments(scope);
      const result = await sweepSGExpiredConversations({
        methods: db,
        loadConfig: (tenantId) => getAppConfig({ tenantId }),
      });
      const journal = await db.findResourceDeletion(req.user.id, 'conversation', [
        req.params.conversationId,
      ]);
      res.json({
        ...result,
        before,
        after: await Conversation.countDocuments(scope),
        state: journal?.state,
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/__e2e/expire-file/:fileId', requireJwtAuth, async (req, res, next) => {
    try {
      const [file] = await db.getFiles(
        { user: req.user.id, file_id: req.params.fileId },
        undefined,
        undefined,
        { includeDeleted: true },
      );
      if (!file || file.source !== 'sg_gateway') return res.status(404).end();
      if (req.query.upload === 'true') {
        const { File } = require('mongoose').models;
        await File.updateOne(
          { user: req.user.id, file_id: file.file_id },
          { $set: { sgUploadExpiresAt: new Date(0) } },
        );
      } else {
        await db.updateFile(
          { file_id: file.file_id, expiredAt: new Date(0) },
          { user: req.user.id },
        );
      }
      if (req.query.defer === 'true') return res.json({ marked: true });
      const result = await runAsSystem(async () => sweepExpiredFiles({ limit: 10 }));
      const journal = await db.findResourceDeletion(req.user.id, 'file', [file.file_id]);
      res.json({ ...result, state: journal?.state });
    } catch (error) {
      next(error);
    }
  });
};
