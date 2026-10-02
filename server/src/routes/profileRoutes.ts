import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { z } from 'zod';

import { asyncHandler } from '../middleware/asyncHandler';
import { validateBody } from '../middleware/validateBody';
import type { AuthenticatedRequest } from '../types/auth';
import type { ProfilePhotoService } from '../services/profilePhotoService';

/** Photo kinds are validated by each role's own zod schema. */
interface PhotoRouteOptions {
  photos: ProfilePhotoService;
  ownerId: (req: AuthenticatedRequest) => string;
  uploadSchema: z.ZodType<{ kind: string; contentType: string; sizeBytes: number }>;
  confirmSchema: z.ZodType<{ kind: string; objectKey: string }>;
  kinds: readonly string[];
}

/**
 * The photo endpoints shared by the driver and merchant profile routers.
 * The owner id always comes from the verified principal (never the request).
 * Responses carry signed URLs only to the caller; nothing here logs them.
 */
export function addPhotoRoutes(router: Router, guard: RequestHandler[], options: PhotoRouteOptions) {
  router.post(
    '/photo-upload',
    ...guard,
    validateBody(options.uploadSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const body = req.body as { kind: string; contentType: string; sizeBytes: number };
      res.set('Cache-Control', 'no-store');
      res.json(await options.photos.requestUpload(options.ownerId(req), body.kind, body.contentType, body.sizeBytes));
    })
  );

  router.post(
    '/photo-confirm',
    ...guard,
    validateBody(options.confirmSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const body = req.body as { kind: string; objectKey: string };
      await options.photos.confirm(options.ownerId(req), body.kind, body.objectKey);
      res.status(204).end();
    })
  );

  router.delete(
    '/photo/:kind',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      if (!options.kinds.includes(req.params.kind)) {
        res.status(400).json({ error: 'invalid_request', message: 'Unknown photo kind.' });
        return;
      }
      await options.photos.remove(options.ownerId(req), req.params.kind);
      res.status(204).end();
    })
  );
}
