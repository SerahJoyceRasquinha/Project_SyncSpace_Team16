import { Router } from 'express';
import { requireMember } from '../middleware/authMiddleware.js';
import { rateLimit } from '../utils/validate.js';
import {
  executeCode,
  languageCatalog,
  refreshProviders,
  providerStatus,
  executionStats
} from '../services/execution/index.js';

/**
 * Code execution endpoints, mounted at /api/workspaces/:workspaceId/execute.
 *
 * mergeParams gives us :workspaceId so requireMember applies unchanged: only a
 * live member with a valid access token can run code, and a removed member's
 * token stops working instantly — the same guarantee every other route has.
 *
 * Nothing here knows which execution provider is in use, and no API key ever
 * crosses this boundary: keys live in the backend environment and are read
 * only inside the adapters. The frontend receives results, never credentials.
 */
const router = Router({ mergeParams: true });

/** GET /languages — the dropdown, plus which providers are actually reachable. */
router.get('/languages', requireMember, async (req, res, next) => {
  try {
    if (req.query.refresh === '1') await refreshProviders();
    res.json(await languageCatalog({ wait: req.query.wait === '1' }));
  } catch (err) {
    next(err);
  }
});

/** GET /providers — diagnostics for debugging a misconfigured deployment. */
router.get('/providers', requireMember, (req, res) => {
  res.json({ providers: providerStatus(), stats: executionStats() });
});

/** POST / — run { language, code, stdin }. */
router.post('/', requireMember, async (req, res, next) => {
  try {
    const limit = rateLimit(`exec:${req.user.userId}`, {
      max: Number(process.env.EXEC_RATE_MAX) || 20,
      windowMs: Number(process.env.EXEC_RATE_WINDOW_MS) || 30_000
    });
    if (!limit.ok) {
      if (limit.retryAfter) res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: limit.message });
    }

    const { language, code, stdin } = req.body || {};
    if (typeof language !== 'string' || !language) {
      return res.status(400).json({ error: 'Pick a language before running the code.' });
    }
    if (typeof code !== 'string') {
      return res.status(400).json({ error: 'The code to run must be sent as text.' });
    }
    if (stdin !== undefined && typeof stdin !== 'string') {
      return res.status(400).json({ error: 'Program input (stdin) must be sent as text.' });
    }

    // executeCode never throws: a failure is a result with ok:false, so the
    // editor always has something meaningful to render.
    const result = await executeCode({
      language,
      code,
      stdin: stdin || '',
      meta: { workspaceId: req.params.workspaceId, userId: req.user.userId }
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

export default router;
