import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// Callers supply only fixed event names and bounded technical metadata. Never
// pass errors, URLs, headers, bodies or environment objects to this boundary.
export function diagnostic(
  event: string,
  fields: Record<string, string | number | boolean> = {},
) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
}
export function requestDiagnostics(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const requestId = randomUUID();
  const started = Date.now();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    if (res.statusCode >= 500)
      diagnostic('http_error', {
        requestId,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
  });
  next();
}
