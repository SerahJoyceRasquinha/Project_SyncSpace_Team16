import { Router } from 'express';
import { requireMember } from '../middleware/authMiddleware.js';
import { rateLimit } from '../utils/validate.js';
import { executeCode, languageCatalog } from '../services/execution/index.js';

/**
 * Code execution endpoints, mounted at /api/workspaces/:workspaceId/execute.
 *
 * mergeParams gives us :workspaceId, so requireMember applies unchanged: only a
 * live member with a valid access token can run code, and a removed member's
 * token dies instantly — the exact same guarantee every other route has.
 *
 * The route layer stays thin on purpose: auth + rate limit here, everything
 * about processes and sandboxes lives in services/execution/.
 */
const router = Router({ mergeParams: true });

/** GET /languages — what the IDE dropdown should offer. */
router.get('/languages', requireMember, (req, res) => {
  res.json({ languages: languageCatalog() });
});

/** POST / — run { language, code, stdin } and return the full result. */
router.post('/', requireMember, async (req, res, next) => {
  try {
    // per-user limit: a stuck finger on Run cannot monopolise the queue
    const limit = rateLimit(`exec:${req.user.userId}`, { max: 10, windowMs: 30_000 });
    if (!limit.ok) return res.status(429).json({ error: limit.message });

    const { language, code, stdin } = req.body || {};
    const result = await executeCode({ language, code, stdin });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

export default router;
