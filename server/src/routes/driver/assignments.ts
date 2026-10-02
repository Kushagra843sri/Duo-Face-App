import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { createRateLimiter } from '../../middleware/rateLimit';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { CustomerCallService } from '../../services/customerCallService';
import { DeliveryProofService } from '../../services/deliveryProofService';
import { DeliveryAssignmentService, toDriverAssignmentDto } from '../../services/deliveryAssignmentService';
import { DeliveryOrderService } from '../../services/deliveryOrderService';
import { DriverService } from '../../services/driverService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

// Exactly one proof of delivery (docs/decisions/028): a fresh GPS fix taken at
// tap time, or the customer's 6-digit code. Strict: nothing else is accepted
// (in particular no driverId).
const deliverBodySchema = z
  .object({
    location: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        accuracyMeters: z.number().finite().min(0).optional(),
      })
      .strict()
      .optional(),
    otp: z.string().regex(/^\d{6}$/, 'The code is 6 digits.').optional(),
  })
  .strict()
  .refine((body) => (body.location !== undefined) !== (body.otp !== undefined), { message: 'Send exactly one of location or otp.' });

/** Masked-call limit per driver: 5 requests / 60 s (per-assignment limits live in the service). */
export const CALL_RATE_LIMIT = { windowMs: 60_000, max: 5 };

/**
 * driverId always comes from req.driver (verified + active by
 * requireActiveDriver) — never from the request body, query, or params. No
 * route here has a :driverId segment, and `?driverId=` is never read.
 */
export function createDriverAssignmentsRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService(),
  assignmentService: DeliveryAssignmentService = new DeliveryAssignmentService(),
  deliveryOrderService: DeliveryOrderService = new DeliveryOrderService(assignmentService),
  proofService: DeliveryProofService = new DeliveryProofService(assignmentService, deliveryOrderService),
  callService: CustomerCallService = new CustomerCallService(assignmentService),
  callLimiter: RequestHandler = createRateLimiter({ ...CALL_RATE_LIMIT, keyFor: (req) => req.driver?.driverId }) as RequestHandler
) {
  const router = Router();

  const guard = [
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('driver'),
    requireActiveDriver(driverService),
  ];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await assignmentService.expireStaleOffersForDriver(req.driver!.driverId);
      const assignments = await assignmentService.listByDriverId(req.driver!.driverId);
      res.json(assignments.map(toDriverAssignmentDto));
    })
  );

  router.get(
    '/:assignmentId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const assignment = await assignmentService.getById(req.params.assignmentId);
      // A 404 for both "doesn't exist" and "belongs to another driver" —
      // never leak that another driver's assignment exists.
      if (!assignment || assignment.driverId !== req.driver!.driverId) {
        res.status(404).json({ error: 'not_found', message: 'Assignment not found.' });
        return;
      }
      res.json(toDriverAssignmentDto(assignment));
    })
  );

  // Order info is reachable only via an assignment this driver owns — there
  // is deliberately no /driver/orders/:orderId (docs/decisions/018).
  router.get(
    '/:assignmentId/order',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await deliveryOrderService.getForDriver(req.driver!, req.params.assignmentId));
    })
  );

  // No request body on any of these — the transition target is implied by
  // the route itself, and driver ownership always comes from req.driver
  // (never a body/query field). Cross-driver / missing-assignment /
  // invalid-transition all surface via the AppError thrown inside
  // DeliveryAssignmentService's transactional updater, caught by
  // asyncHandler -> the existing errorHandler.
  router.post(
    '/:assignmentId/accept',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const assignment = await assignmentService.acceptAssignment(req.params.assignmentId, req.driver!.driverId);
      res.json(toDriverAssignmentDto(assignment));
    })
  );

  router.post(
    '/:assignmentId/reject',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const assignment = await assignmentService.rejectAssignment(req.params.assignmentId, req.driver!.driverId);
      res.json(toDriverAssignmentDto(assignment));
    })
  );

  router.post(
    '/:assignmentId/pickup',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const assignment = await assignmentService.markPickedUp(req.params.assignmentId, req.driver!.driverId);
      res.json(toDriverAssignmentDto(assignment));
    })
  );

  // Delivery needs proof of arrival (docs/decisions/028): the driver's own
  // ownership + status are re-checked inside DeliveryProofService.
  router.post(
    '/:assignmentId/deliver',
    ...guard,
    validateBody(deliverBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const body = req.body as z.infer<typeof deliverBodySchema>;
      const proof = body.otp !== undefined ? { otp: body.otp } : { location: body.location! };
      const assignment = await proofService.deliver(req.driver!, req.params.assignmentId, proof);
      res.json(toDriverAssignmentDto(assignment));
    })
  );

  // Masked call to the customer: no body, and the response never contains a phone number.
  router.post(
    '/:assignmentId/call-customer',
    ...guard,
    callLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.status(202).json(await callService.callCustomer(req.driver!, req.params.assignmentId));
    })
  );

  return router;
}
