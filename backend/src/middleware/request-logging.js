import { randomUUID } from 'node:crypto';

export function requestLogging(req, res, next) {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(JSON.stringify({
      event: 'http_request', requestId, method: req.method,
      path: req.path, status: res.statusCode, durationMs: Math.round(durationMs),
    }));
  });
  next();
}
