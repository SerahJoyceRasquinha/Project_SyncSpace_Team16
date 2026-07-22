import { Router } from 'express';
import * as ctrl from '../controllers/workspaceController.js';
import { requireMember, requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

// ---- public --------------------------------------------------------------
router.post('/', ctrl.create);
router.get('/:workspaceId', ctrl.peek);
router.post('/:workspaceId/join', ctrl.join);

// ---- any authenticated member -------------------------------------------
router.get('/:workspaceId/me', requireMember, ctrl.me);

// ---- administrator only --------------------------------------------------
router.get('/:workspaceId/requests', requireMember, requireAdmin, ctrl.listRequests);
router.post('/:workspaceId/requests/:requestId/approve', requireMember, requireAdmin, ctrl.approve);
router.post('/:workspaceId/requests/:requestId/reject', requireMember, requireAdmin, ctrl.reject);
router.patch('/:workspaceId/policy', requireMember, requireAdmin, ctrl.updatePolicy);
router.delete('/:workspaceId/members/:userId', requireMember, requireAdmin, ctrl.removeMember);
router.post('/:workspaceId/close', requireMember, requireAdmin, ctrl.close);

export default router;
