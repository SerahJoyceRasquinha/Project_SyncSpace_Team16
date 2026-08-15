import { Router } from 'express';
import { verifyToken } from '../utils/token.js';
import { findWorkspace, findMember } from '../services/workspaceStore.js';
import { rateLimit } from '../utils/validate.js';
import { validateAIRequest } from '../services/ai/validators.js';
import { planRequest } from '../services/ai/request.js';
import { streamAI, runAI, isConfigured, selectModel } from '../services/ai/aiService.js';
import { SUPPORTED_ACTIONS } from '../services/ai/prompts.js';

/**
 * AI endpoints, mounted at /api/ai.
 *
 * Two problems here besides speed, both found while tracing the request path:
 *
 *   1. THE ENDPOINT WAS UNAUTHENTICATED. `router.post('/')` had no middleware.
 *      The frontend dutifully attached a Bearer token and the server never
 *      looked at it — so anyone who could reach the port could spend the
 *      project's Gemini quota, at 30 000 characters a request, without ever
 *      joining a workspace. Every other route in this codebase is guarded;
 *      this one was not.
 *
 *   2. /health reported `providerConfigured: Boolean(process.env.OPENAI_API_KEY)`
 *      while the service ran on Gemini. It answered "not configured" on a
 *      correctly configured server and would answer "configured" on one with a
 *      stale OpenAI key and no Gemini key at all.
 */
const router = Router();

/**
 * Accepts either identity this app issues: a workspace ACCESS token (someone
 * inside a room) or a USER token (a signed-in account). Access tokens are
 * checked against live membership, so a removed member loses AI access at the
 * same instant they lose everything else.
 */
async function requireAiAccess(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'You are not signed in. Open SyncSpace AI from a workspace you have joined.' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Your session has expired. Please join the workspace again.' });
  }

  if (payload.kind === 'user') {
    req.aiIdentity = { id: `user:${payload.userId}`, kind: 'user' };
    return next();
  }

  if (payload.kind !== 'access') {
    return res.status(401).json({ error: 'That session cannot be used for AI requests.' });
  }

  const workspace = await findWorkspace(payload.workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: 'This workspace no longer exists.' });
  }
  if (workspace.status === 'closed') {
    return res.status(410).json({ error: 'This workspace has been closed by its administrator.' });
  }
  if (!findMember(workspace, payload.userId)) {
    return res.status(403).json({ error: 'You have been removed from this workspace.' });
  }

  req.aiIdentity = { id: `ws:${payload.workspaceId}:${payload.userId}`, kind: 'member' };
  next();
}

/** Shared front half of both endpoints: limit, validate, plan. */
function prepare(req, res) {
  const limit = rateLimit(`ai:${req.aiIdentity.id}`, {
    max: Number(process.env.AI_RATE_MAX) || 20,
    windowMs: Number(process.env.AI_RATE_WINDOW_MS) || 60_000
  });
  if (!limit.ok) {
    if (limit.retryAfter) res.set('Retry-After', String(limit.retryAfter));
    res.status(429).json({ error: limit.message });
    return null;
  }

  const validation = validateAIRequest(req.body);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error, code: validation.code });
    return null;
  }

  return planRequest(validation.data);
}

/**
 * GET /api/ai/health — what is actually configured, checked against the
 * provider actually in use.
 */
router.get('/health', (req, res) => {
  const configured = isConfigured();
  const fast = selectModel({ action: 'chat', complexity: 'simple' });
  const smart = selectModel({ action: 'debug', complexity: 'deep' });

  res.json({
    success: true,
    service: 'syncspace-ai',
    status: configured ? 'healthy' : 'unconfigured',
    provider: 'gemini',
    providerConfigured: configured,
    models: { fast: fast.model, smart: smart.model, pinned: fast.tier === 'pinned' },
    streaming: true,
    actions: SUPPORTED_ACTIONS
  });
});

/**
 * POST /api/ai/stream — Server-Sent Events.
 *
 * SSE rather than WebSocket because this is a one-way, one-shot text stream
 * over the HTTP request that started it: no new transport, no socket.io room
 * semantics, no reconnection state. The existing socket layer stays untouched.
 *
 * Headers are flushed BEFORE the provider is called. That is the point: the
 * browser's time-to-first-byte becomes backend latency (single-digit ms)
 * instead of model latency, so the UI can switch from "thinking" to "streaming"
 * immediately rather than after a minute of silence.
 */
router.post('/stream', requireAiAccess, async (req, res) => {
  const plan = prepare(req, res);
  if (!plan) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses by default, which would re-introduce
    // exactly the "wait for everything" behaviour we just removed.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const send = (event) => {
    if (res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The client going away must stop the provider call, not leak it.
  const abort = new AbortController();
  req.on('close', () => { if (!res.writableEnded) abort.abort(); });

  try {
    if (plan.kind === 'clarify') {
      // Answered without touching the provider: no key spend, no latency.
      send({ type: 'meta', action: plan.reason, clarification: true, model: null });
      send({ type: 'delta', text: plan.answer });
      send({ type: 'done', chars: plan.answer.length, totalMs: 0, clarification: true });
      return res.end();
    }

    for await (const event of streamAI(plan, { signal: abort.signal })) {
      const ok = send(event);
      // Back-pressure: if the socket buffer is full, wait for it to drain
      // rather than queueing the whole answer in memory.
      if (ok === false) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (error) {
    console.error('[ai] stream failure:', error?.message || error);
    send({ type: 'error', code: 'server-error', message: 'The AI request failed unexpectedly. Please try again.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/ai — the buffered path, kept for compatibility and for any client
 * that cannot read a stream. Same planner, same provider code underneath.
 */
router.post('/', requireAiAccess, async (req, res, next) => {
  try {
    const plan = prepare(req, res);
    if (!plan) return;

    if (plan.kind === 'clarify') {
      return res.json({
        success: true,
        provider: 'local',
        answer: plan.answer,
        meta: { clarification: true, reason: plan.reason }
      });
    }

    const abort = new AbortController();
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const result = await runAI(plan, { signal: abort.signal });

    if (!result.success) {
      const status = result.code === 'rate-limited' ? 429
        : result.code === 'not-configured' ? 503
          : 502;
      return res.status(status).json({
        success: false,
        error: result.error,
        code: result.code,
        answer: result.answer || undefined
      });
    }

    return res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
