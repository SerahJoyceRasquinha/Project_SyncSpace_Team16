import { Router } from 'express';
import * as ctrl from '../controllers/workspaceController.js';
import {
  requireMember,
  requireAdmin,
  requireUser,
  optionalUser
} from '../middleware/authMiddleware.js';

const router = Router();

// ---- public --------------------------------------------------------------
// optionalUser lets signed-in users attach their membership (dashboard) while
// keeping the whole flow fully usable by anonymous guests.
router.post('/', optionalUser, ctrl.create);
router.get('/:workspaceId', ctrl.peek);
router.post('/:workspaceId/join', optionalUser, ctrl.join);
router.post('/:workspaceId/enter', requireUser, ctrl.enter);

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
