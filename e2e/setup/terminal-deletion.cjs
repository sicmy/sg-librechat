module.exports = function installTerminalDeletion(db) {
  const {
    GenerationJobManager,
    deleteSGFileResources,
    resolveSGDeletionEndpoint,
  } = require('@librechat/api');
  const { getTenantId } = require('@librechat/data-schemas');
  const { getAppConfig } = require('~/server/services/Config');
  const app = require('../../api/server/index.js');
  const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
  const deleted = new Map();
  const observations = [];
  const read = db.getMessages;
  db.getMessages = async function (filter, select, options) {
    const messages = await read(filter, select, options);
    if (
      typeof filter.user !== 'string' ||
      typeof filter.conversationId !== 'string' ||
      options?.limit !== 2 ||
      !Array.isArray(filter.messageId?.$in) ||
      deleted.has(filter.conversationId)
    )
      return messages;
    const response = messages.find(
      (message) => !message.isCreatedByUser && message.metadata?.sgArtifacts?.artifacts?.length,
    );
    if (!response) return messages;
    const fileId = response.metadata.sgArtifacts.artifacts[0].file_id;
    const [file] = await db.getFiles({ user: filter.user, file_id: fileId });
    if (!file) throw new Error('synthetic_terminal_file_missing');
    const config = await getAppConfig({ tenantId: getTenantId() });
    const endpointConfig = resolveSGDeletionEndpoint(file.metadata.sgGateway.endpoint, config);
    await deleteSGFileResources({
      file,
      userId: filter.user,
      tenantId: getTenantId(),
      endpointConfig,
      allowedAddresses: config.endpoints?.allowedAddresses,
      methods: db,
    });
    deleted.set(filter.conversationId, { userId: filter.user, fileId, published: false });
    return read(filter, select, options);
  };
  const publish = GenerationJobManager.publishTerminalClaim.bind(GenerationJobManager);
  GenerationJobManager.publishTerminalClaim = async function (claim, payload, ...args) {
    const record = deleted.get(payload?.conversation?.conversationId);
    if (payload?.final && record && !record.published) {
      record.published = true;
      observations.push({
        userId: record.userId,
        fileId: record.fileId,
        responseArtifacts: payload.responseMessage.metadata?.sgArtifacts?.artifacts?.length ?? 0,
        requestFiles: payload.requestMessage?.files?.length ?? 0,
      });
    }
    return publish(claim, payload, ...args);
  };
  app.get('/__e2e/terminal-observations', requireJwtAuth, (req, res) => {
    res.json(observations.filter((item) => item.userId === req.user.id));
  });
};
