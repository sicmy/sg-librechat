module.exports = function installDeliveryFaults(db) {
  const recordFailure = async (stage, resource_id) => {
    const response = await fetch('http://127.0.0.1:4010/observations/delivery-failure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, resource_id }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('synthetic_failure_observation_unavailable');
  };
  const failedRegistrations = new Set();
  const createFile = db.createFile;
  const saveMessage = db.saveMessage;
  db.createFile = async function (file, ...args) {
    if (
      file.source === 'sg_gateway' &&
      file.filename === 'generated-image.png' &&
      !failedRegistrations.has(file.conversationId)
    ) {
      failedRegistrations.add(file.conversationId);
      await recordFailure('registration', file.file_id);
      throw new Error('synthetic_artifact_registration_failure');
    }
    return createFile(file, ...args);
  };
  db.saveMessage = async function (context, message, ...args) {
    if (message.metadata?.sgArtifacts && message.metadata?.sgGeneration?.kind === 'tts') {
      await recordFailure('message', message.messageId);
      throw new Error('synthetic_generated_message_write_failure');
    }
    return saveMessage(context, message, ...args);
  };
};
