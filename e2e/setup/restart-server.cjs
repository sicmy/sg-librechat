const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { once } = require('events');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  if (process.env.E2E_USE_MEMORY_MONGO !== 'true' || !process.env.DOTENV_CONFIG_PATH) {
    throw new Error('restart_supervisor_requires_isolated_test_configuration');
  }
  const mongo = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', dbName: 'LibreChat-restart-e2e' },
  });
  const uri = mongo.getUri('LibreChat-restart-e2e');
  const client = await new MongoClient(uri).connect();
  const db = client.db();
  let child;
  let generation = 0;
  let exited = true;
  let stopping = false;
  const boot = () => {
    if (!exited || stopping) throw new Error('test_child_already_running');
    generation++;
    exited = false;
    child = spawn(process.execPath, [path.join(__dirname, 'start-server.js')], {
      env: {
        ...process.env,
        MONGO_URI: uri,
        E2E_USE_MEMORY_MONGO: 'false',
        E2E_DELETION_CRASH: generation === 1 ? 'true' : 'false',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', () => {
      exited = true;
    });
  };
  const stopChild = async () => {
    if (child && !exited) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await stopChild();
    await client.close();
    await mongo.stop();
    control.close();
  };
  const control = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-e2e-control'] !== 'synthetic-restart-control') {
      res.writeHead(403).end('{}');
      return;
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1:4030');
      if (req.method === 'GET' && url.pathname === '/status') {
        const jobs = await db
          .collection('resource_deletions')
          .find(
            {},
            {
              projection: {
                resourceIds: 1,
                state: 1,
                attempts: 1,
                remoteComplete: 1,
                reconcileAttempts: 1,
                leaseUntil: 1,
              },
            },
          )
          .toArray();
        res.end(
          JSON.stringify({
            pid: child?.pid,
            generation,
            exited,
            jobs,
            expiryBodies: await db
              .collection('messages')
              .countDocuments({ messageId: 'synthetic-expiry-restart', text: { $exists: true } }),
            expiryReferences: await db.collection('messages').countDocuments({
              messageId: 'synthetic-expiry-restart',
              expiryReferencesOnly: true,
              'files.file_id': 'file_restart_expiry_reference',
            }),
            tools: await db.collection('toolcalls').countDocuments(),
            shares: await db.collection('sharedlinks').countDocuments(),
            lateRows: await db
              .collection('files')
              .countDocuments({ filename: 'synthetic-late.png' }),
            lateConversations: await db
              .collection('conversations')
              .countDocuments({ conversationId: { $in: jobs.flatMap((job) => job.resourceIds) } }),
            lateMessages: await db
              .collection('messages')
              .countDocuments({ conversationId: { $in: jobs.flatMap((job) => job.resourceIds) } }),
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/seed') {
        const id = url.searchParams.get('conversationId');
        if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid_fixture_conversation');
        const convo = await db.collection('conversations').findOne({ conversationId: id });
        if (!convo) throw new Error('fixture_conversation_not_found');
        await db.collection('toolcalls').insertOne({
          user: new ObjectId(convo.user),
          conversationId: id,
          messageId: 'synthetic-restart',
          toolId: 'synthetic-restart',
        });
        await db
          .collection('sharedlinks')
          .insertOne({ user: convo.user, conversationId: id, shareId: 'synthetic-restart' });
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/restart') {
        if (!exited) {
          res.writeHead(409).end('{}');
          return;
        }
        boot();
        res.end(JSON.stringify({ pid: child.pid, generation }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/stop-child') {
        await stopChild();
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/seed-late') {
        if (!exited) {
          res.writeHead(409).end('{}');
          return;
        }
        const id = url.searchParams.get('conversationId');
        if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid_fixture_conversation');
        const job = await db
          .collection('resource_deletions')
          .findOne({ kind: 'conversation', state: 'complete', resourceIds: [id] });
        if (!job) throw new Error('completed_fixture_deletion_not_found');
        const expiryConversationId = randomUUID();
        await db.collection('conversations').insertOne({
          user: job.userId,
          conversationId: expiryConversationId,
          endpoint: 'SG AI Gateway',
          expiredAt: new Date('2100-01-01'),
        });
        await db.collection('messages').insertOne({
          user: job.userId,
          conversationId: expiryConversationId,
          messageId: 'synthetic-expiry-restart',
          isCreatedByUser: true,
          expiredAt: new Date(0),
          text: 'synthetic expiry restart body',
          files: [
            { file_id: 'file_restart_expiry_reference', filename: 'synthetic-private-name.txt' },
          ],
        });
        await db
          .collection('conversations')
          .insertOne({ user: job.userId, conversationId: id, endpoint: 'SG AI Gateway' });
        await db.collection('messages').insertOne({
          user: job.userId,
          conversationId: id,
          messageId: 'synthetic-late',
          text: 'synthetic late record',
        });
        await db.collection('files').insertOne({
          user: new ObjectId(job.userId),
          conversationId: id,
          file_id: 'file_synthetic_late',
          filename: 'synthetic-late.png',
          filepath: '/synthetic-late.png',
          bytes: 1,
          type: 'image/png',
          source: 'sg_gateway',
        });
        await db.collection('toolcalls').insertOne({
          user: new ObjectId(job.userId),
          conversationId: id,
          messageId: 'synthetic-late',
          toolId: 'synthetic-late',
        });
        await db
          .collection('sharedlinks')
          .insertOne({ user: job.userId, conversationId: id, shareId: 'synthetic-late' });
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        res.end('{}');
        await stop();
        return;
      }
      res.writeHead(404).end('{}');
    } catch {
      res.writeHead(500).end(JSON.stringify({ error: 'synthetic_supervisor_operation_failed' }));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(4030, '127.0.0.1', resolve);
    });
  } catch (error) {
    await client.close();
    await mongo.stop();
    throw error;
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  boot();
}
main().catch(() => {
  console.error('restart_supervisor_failed');
  process.exitCode = 1;
});
