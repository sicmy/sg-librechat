module.exports = function installStaleJobFixture(db) {
  const {
    GenerationJobManager,
    deleteSGFileResources,
    resolveSGDeletionEndpoint,
  } = require('@librechat/api');
  const { getTenantId } = require('@librechat/data-schemas');
  const { getAppConfig } = require('~/server/services/Config');
  const fileCaches = new Map();
  const app = require('../../api/server/index.js');
  const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
  app.post('/__e2e/file-cache/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const id = req.params.conversationId;
      const conversation = await db.getConvo(req.user.id, id);
      if (!conversation) return res.status(404).end();
      const rows = await db.getMessages({ user: req.user.id, conversationId: id });
      const response = rows.filter((row) => row.metadata?.sgArtifacts?.artifacts?.length).at(-1);
      const request = rows.find((row) => row.messageId === response?.parentMessageId);
      const files = await db.getFiles({ user: req.user.id, conversationId: id });
      const removed = files.find(
        (file) => file.file_id === response?.metadata.sgArtifacts.artifacts[0].file_id,
      );
      const kept = files.find((file) => file.file_id !== removed?.file_id);
      if (!request || !removed || !kept) throw new Error('synthetic_file_cache_inputs_missing');
      const refs = [{ file_id: removed.file_id }, { file_id: kept.file_id }];
      await db.updateMessage(req.user.id, { messageId: request.messageId, files: refs });
      const job = await GenerationJobManager.createJob(id, req.user.id, id, {
        initialMetadata: {
          responseMessageId: response.messageId,
          userMessage: {
            messageId: request.messageId,
            conversationId: id,
            text: request.text,
            files: refs,
          },
        },
      });
      fileCaches.set(id, {
        userId: req.user.id,
        job,
        event: {
          final: true,
          conversation,
          requestMessage: { ...request, files: refs },
          responseMessage: response,
        },
      });
      const config = await getAppConfig({ tenantId: getTenantId() });
      await deleteSGFileResources({
        file: removed,
        userId: req.user.id,
        tenantId: getTenantId(),
        methods: db,
        endpointConfig: resolveSGDeletionEndpoint(removed.metadata.sgGateway.endpoint, config),
        allowedAddresses: config.endpoints?.allowedAddresses,
      });
      const state = await GenerationJobManager.getResumeState(id, job.createdAt);
      res.json({
        removed: removed.file_id,
        kept: kept.file_id,
        cachedFiles: state?.userMessage?.files?.length ?? 0,
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/__e2e/file-cache/:conversationId/publish', requireJwtAuth, async (req, res, next) => {
    try {
      const entry = fileCaches.get(req.params.conversationId);
      if (entry?.userId !== req.user.id) return res.status(404).end();
      let timer;
      try {
        await Promise.race([
          entry.job.readyPromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('synthetic_subscriber_timeout')), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      entry.claim = await GenerationJobManager.claimTerminalJob(
        req.params.conversationId,
        'complete',
        undefined,
        entry.job.createdAt,
        { persistencePending: true },
      );
      if (!entry.claim) throw new Error('synthetic_terminal_claim_missing');
      await GenerationJobManager.publishTerminalClaim(entry.claim, entry.event);
      const cached = await GenerationJobManager.getJob(req.params.conversationId);
      res.json({
        cachedArtifacts:
          cached?.finalEvent?.responseMessage?.metadata?.sgArtifacts?.artifacts?.length ?? 0,
      });
    } catch (error) {
      next(error);
    }
  });
  app.delete('/__e2e/file-cache/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const id = req.params.conversationId,
        entry = fileCaches.get(id);
      if (entry?.userId !== req.user.id) return res.status(404).end();
      if (entry.claim) await GenerationJobManager.finishTerminalJob(entry.claim);
      else
        await GenerationJobManager.completeJob(
          id,
          'synthetic fixture cleanup',
          entry.job.createdAt,
        );
      fileCaches.delete(id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  app.post('/__e2e/stale-job/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const id = req.params.conversationId;
      if (!(await db.isResourceWriteBlocked(req.user.id, [id]))) return res.status(409).end();
      const existing = await GenerationJobManager.getJob(id);
      if (
        existing &&
        (existing.metadata.userId !== req.user.id ||
          (existing.metadata.tenantId != null && existing.metadata.tenantId !== req.user.tenantId))
      )
        return res.status(403).end();
      const job = await GenerationJobManager.createJob(id, req.user.id, id);
      await GenerationJobManager.emitChunk(id, {
        event: 'on_run_step',
        data: {
          id: 'synthetic-stale-step',
          runId: 'synthetic-stale-response',
          index: 0,
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'synthetic-call', name: 'oauth_mcp_Synthetic', args: '' }],
          },
        },
      });
      await GenerationJobManager.emitChunk(id, {
        event: 'on_run_step_delta',
        data: {
          id: 'synthetic-stale-step',
          delta: {
            type: 'tool_calls',
            tool_calls: [{ name: 'oauth_mcp_Synthetic', args: '' }],
            auth: 'https://example.invalid/synthetic-authorization',
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        },
      });
      const state = await GenerationJobManager.getResumeState(id, job.createdAt);
      res.json({ cachedEvents: state?.replayEvents?.length ?? 0 });
    } catch (error) {
      next(error);
    }
  });
  app.delete('/__e2e/stale-job/:conversationId', requireJwtAuth, async (req, res, next) => {
    try {
      const id = req.params.conversationId;
      const job = await GenerationJobManager.getJob(id);
      if (
        job?.metadata.userId !== req.user.id ||
        (job.metadata.tenantId != null && job.metadata.tenantId !== req.user.tenantId)
      )
        return res.status(404).end();
      await GenerationJobManager.completeJob(id, 'synthetic fixture cleanup', job.createdAt);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
};
