import { Router } from 'express';
import * as svc from '../services/authService.js';
import { requireUser } from '../middleware/authMiddleware.js';
import { validateEmail, validateAccountPassword, validateUsername } from '../utils/validate.js';

const router = Router();

/** POST /api/auth/signup — create an account, returns a user token. */
router.post('/signup', async (req, res, next) => {
  try {
    const email = validateEmail(req.body?.email);
    if (!email.ok) return res.status(400).json({ error: email.message });

    const username = validateUsername(req.body?.username);
    if (!username.ok) return res.status(400).json({ error: username.message });

    const password = validateAccountPassword(req.body?.password);
    if (!password.ok) return res.status(400).json({ error: password.message });

    const result = await svc.signup({
      email: email.email,
      username: username.username,
      password: password.password
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
    return res.status(201).json({ ok: true, token: result.token, user: result.user });
  } catch (err) {
    next(err);
  }
});

/** POST /api/auth/login — returns a fresh user token. */
router.post('/login', async (req, res, next) => {
  try {
    const email = validateEmail(req.body?.email);
    if (!email.ok) return res.status(400).json({ error: email.message });

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) return res.status(400).json({ error: 'Please enter your password.' });

    const result = await svc.login({ email: email.email, password });
    if (!result.ok) return res.status(result.status || 401).json({ error: result.message });
    return res.json({ ok: true, token: result.token, user: result.user });
  } catch (err) {
    next(err);
  }
});

/** GET /api/auth/me — the signed-in account + its workspaces. */
router.get('/me', requireUser, async (req, res) => {
  const result = await svc.getUser(req.user.userId);
  if (!result.ok) return res.status(result.status || 404).json({ error: result.message });
  res.json({ ok: true, user: result.user, workspaces: result.workspaces });
});

export default router;

