import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { authenticateFirebase } from '../../middleware/authenticate';

/** What the Customer App may offer. Today: whether online payment is set up on this server. */
export function createCustomerConfigRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  onlinePayment = false
) {
  const router = Router();
  router.get('/', authenticateFirebase(verifier), (_req, res) => {
    res.json({ onlinePayment });
  });
  return router;
}
