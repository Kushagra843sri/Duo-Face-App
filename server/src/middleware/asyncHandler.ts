import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 doesn't catch a rejected promise from an async handler on its
 * own — this forwards it to next(err), so the existing errorHandler
 * middleware (server/src/middleware/errorHandler.ts) handles it instead of
 * an unhandled rejection.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
