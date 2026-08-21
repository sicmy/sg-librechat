const crypto = require('node:crypto');
const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');

const router = express.Router();
const maximumResponseBytes = 6 * 1024 * 1024;

function endpoint() {
  const value = process.env.PORTAL_ADAPTER_INTERNAL_URL || 'https://portal-adapter:3080';
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const internal = !host.includes('.') || host.endsWith('.internal') || host === 'localhost' || host === '127.0.0.1';
  if (url.protocol !== 'https:' || !internal || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('COMPANY_KNOWLEDGE_ENDPOINT_INVALID');
  return value.replace(/\/$/, '');
}

function userId(req) {
  const value = String(req.user?.id ?? req.user?._id ?? '');
  return value.length >= 1 && value.length <= 256 ? value : undefined;
}

async function proxy(req, res, path) {
  const user = userId(req); const key = process.env.PORTAL_PREVIEW_API_KEY;
  const trace = crypto.randomBytes(16).toString('hex');
  if (!user || !key || key.length < 16) return res.status(503).json({ error: { code: 'COMPANY_KNOWLEDGE_UNAVAILABLE', message: 'Knowledge is not available', trace_id: trace } });
  const headers = { authorization: `Bearer ${key}`, 'x-librechat-user-id': user, 'x-librechat-conversation-id': String(req.body?.conversation_id ?? `knowledge:${user}`).slice(0, 256), 'x-trace-id': trace };
  if (req.method !== 'GET') headers['content-type'] = 'application/json';
  let response;
  try { response = await fetch(`${endpoint()}${path}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : JSON.stringify(req.body), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { return res.status(503).json({ error: { code: 'COMPANY_KNOWLEDGE_UNAVAILABLE', message: 'Knowledge is not available', trace_id: trace } }); }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumResponseBytes) return res.status(502).json({ error: { code: 'COMPANY_KNOWLEDGE_RESPONSE_INVALID', message: 'Knowledge response is invalid', trace_id: trace } });
  const contentType = response.headers.get('content-type');
  if (contentType) res.set('content-type', contentType);
  const disposition = response.headers.get('content-disposition');
  if (disposition && /^attachment; filename="[0-9a-f-]+\.txt"$/.test(disposition)) res.set('content-disposition', disposition);
  return res.status(response.status).send(body);
}

router.use(requireJwtAuth);
router.get('/bases', (req, res) => proxy(req, res, '/api/company/knowledge/bases'));
router.get('/bases/:kbId/documents', (req, res) => proxy(req, res, `/api/company/knowledge/bases/${encodeURIComponent(req.params.kbId)}/documents`));
router.post('/chat', (req, res) => proxy(req, res, '/api/company/knowledge/chat'));
router.get('/citations/:documentId', (req, res) => proxy(req, res, `/api/company/knowledge/citations/${encodeURIComponent(req.params.documentId)}`));
router.get('/citations/:documentId/download', (req, res) => proxy(req, res, `/api/company/knowledge/citations/${encodeURIComponent(req.params.documentId)}/download`));

module.exports = router;
