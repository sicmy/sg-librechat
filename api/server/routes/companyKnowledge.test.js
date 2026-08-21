const express = require('express');
const request = require('supertest');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, _res, next) => { req.user = { _id: 'server-session-user' }; next(); });

describe('Company Knowledge authenticated proxy', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { process.env.PORTAL_ADAPTER_INTERNAL_URL = 'https://portal-adapter:3080'; process.env.PORTAL_PREVIEW_API_KEY = 'runtime-preview-key'; });
  afterEach(() => { global.fetch = originalFetch; delete process.env.PORTAL_ADAPTER_INTERNAL_URL; delete process.env.PORTAL_PREVIEW_API_KEY; });

  function app() { const value = express(); value.use(express.json()); value.use('/api/company/knowledge', require('./companyKnowledge')); return value; }

  test('derives user identity from authenticated session and never from the body', async () => {
    let observed;
    global.fetch = jest.fn(async (_url, init) => { observed = init; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); });
    const response = await request(app()).post('/api/company/knowledge/chat').send({ conversation_id: 'conversation-1', user_id: 'attacker', roles: ['admin'] });
    expect(response.status).toBe(200);
    expect(observed.headers['x-librechat-user-id']).toBe('server-session-user');
    expect(observed.headers.authorization).toBe('Bearer runtime-preview-key');
    expect(observed.headers).not.toHaveProperty('x-forwarded-authorization');
    expect(JSON.parse(observed.body).user_id).toBe('attacker');
  });

  test('uses only the configured internal adapter and maps transport failure safely', async () => {
    global.fetch = jest.fn(async () => { throw new Error('redirect rejected'); });
    const response = await request(app()).get('/api/company/knowledge/bases');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('COMPANY_KNOWLEDGE_UNAVAILABLE');
    expect(response.text).not.toContain('redirect rejected');
  });
});
