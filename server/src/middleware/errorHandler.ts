import type { NextFunction, Request, Response } from 'express';

export class AppError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.name, message: err.message });
    return;
  }

  console.error(err);
  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(500).json({ error: 'internal_server_error', message });
}
