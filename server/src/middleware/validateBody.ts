import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

/**
 * The first concrete implementation of CLAUDE.md's "validate every request
 * body with zod" rule as reusable middleware — nothing needed it until
 * Phase 6's inventory routes.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: result.error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }

    req.body = result.data;
    next();
  };
}
